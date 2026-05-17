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

export async function deliverWebhook(_env: Env, p: WebhookPayload): Promise<{
  ok: boolean; status?: number; retryable: boolean; error?: string;
}> {
  if (!/^https?:\/\//.test(p.url)) return { ok: false, retryable: false, error: "bad_url" };
  const raw = JSON.stringify(p.body);
  const sig = await hmacSha256Hex(p.secret, raw);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIDataSignal-Webhooks/1.0",
        "X-AIDS-Signature": `sha256=${sig}`,
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

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
