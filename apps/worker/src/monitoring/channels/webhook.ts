// Generic HMAC-signed webhook POST.
//
// Signature header: `X-AIDS-Signature: sha256=<hex>` over the raw JSON
// request body using the rule's `webhook_secret`.
//
// Retries are scheduled by the dispatcher (durable, persisted in
// alert_events.next_attempt_at). This module performs ONE attempt.

import type { Env } from "../../types";

interface WebhookPayload {
  url: string;
  secret: string;
  body: Record<string, unknown>;
}

export async function deliverWebhook(env: Env, p: WebhookPayload): Promise<{
  ok: boolean; status?: number; retryable: boolean; error?: string;
}> {
  // HTTPS-only: webhook bodies carry alert payloads + HMAC signatures
  // and must never traverse plaintext. Reject http:// up front (not
  // retryable — operator must fix the URL).
  if (!/^https:\/\//.test(p.url)) return { ok: false, retryable: false, error: "bad_url_https_required" };
  // Per-host rate limit (same RL_HOST binding the crawler uses). A noisy
  // webhook destination must not starve other tenants; if the limiter
  // rejects us we mark the attempt retryable so the dispatcher reschedules.
  let host = "";
  try { host = new URL(p.url).hostname; } catch { return { ok: false, retryable: false, error: "bad_url" }; }
  if (env.RL_HOST) {
    try {
      const r = await env.RL_HOST.limit({ key: `webhook:${host}` });
      if (!r.success) return { ok: false, status: 429, retryable: true, error: "rate_limited" };
    } catch { /* limiter unavailable — proceed */ }
  }
  const raw = canonicalJson(p.body);
  const sig = await signHmac(p.secret, raw);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIDataSignal-Webhooks/1.0",
        "X-AIDS-Signature": sig,
        "X-AIDS-Timestamp": new Date().toISOString(),
      },
      body: raw,
      signal: ctl.signal,
    });
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, retryable, error: `webhook:${res.status}:${txt.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, retryable: false };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      ok: false,
      retryable: true,
      error: (e as Error).name === "AbortError" ? `webhook_timeout:${msg}` : `webhook_network:${msg}`,
    };
  } finally {
    clearTimeout(tm);
  }
}

/**
 * Byte-stable JSON serialization. Webhooks sign this exact byte sequence,
 * so retries must produce the identical body. Currently this is just
 * `JSON.stringify`, but the indirection lets us swap in a canonical
 * serializer (sorted keys, fixed number format) without touching callers.
 */
export function canonicalJson(body: unknown): string {
  return JSON.stringify(body);
}

/** Returns `sha256=<hex>` for direct use in the `X-AIDS-Signature` header. */
export async function signHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}
