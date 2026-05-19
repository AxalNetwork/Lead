// Task #45: shared helpers for source modules.
//
// * KV-backed cursor store (per-source opaque string).
// * KV-backed enabled toggle (admin UI flips this).
// * R2 raw-HTML archive helper that returns a stable key per (source,
//   day, content-sha256) so re-crawls of identical bodies dedupe.

import type { Env } from "../../types";

const CURSOR_PREFIX = "crawler:cursor:";
const ENABLED_PREFIX = "crawler:enabled:";

export async function getCursor(env: Env, source: string): Promise<string | null> {
  return (await env.SCRAPE_CACHE.get(`${CURSOR_PREFIX}${source}`)) ?? null;
}

export async function setCursor(env: Env, source: string, value: string | null): Promise<void> {
  if (value == null) return;
  await env.SCRAPE_CACHE.put(`${CURSOR_PREFIX}${source}`, value, { expirationTtl: 60 * 60 * 24 * 30 });
}

export async function isEnabled(env: Env, source: string, defaultValue: boolean): Promise<boolean> {
  const v = await env.SCRAPE_CACHE.get(`${ENABLED_PREFIX}${source}`);
  if (v == null) return defaultValue;
  return v === "1";
}

export async function setEnabled(env: Env, source: string, enabled: boolean): Promise<void> {
  await env.SCRAPE_CACHE.put(`${ENABLED_PREFIX}${source}`, enabled ? "1" : "0");
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const arr = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Archive a raw fetch into the RAW_HTML R2 bucket. Returns the object key
 * so the caller can stash it on the signal row for later inspection.
 * The key is content-addressed so duplicate bodies collapse to one R2
 * object. `extension` should match the body's actual format.
 */
export async function archiveRaw(
  env: Env,
  source: string,
  body: string | ArrayBuffer,
  extension: "html" | "json" | "xml" | "txt" = "html",
): Promise<string | undefined> {
  if (!env.RAW_HTML) return undefined;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  if (!text || text.length < 64) return undefined;
  const sha = await sha256Hex(text);
  const day = new Date().toISOString().slice(0, 10);
  const key = `crawls/${source}/${day}/${sha}.${extension}`;
  try {
    // Idempotent: only put when missing. R2 head() is cheap and prevents
    // re-uploads of identical bodies during a single source pass.
    const head = await env.RAW_HTML.head(key).catch(() => null);
    if (!head) {
      await env.RAW_HTML.put(key, text, {
        httpMetadata: { contentType: extension === "json" ? "application/json" : extension === "xml" ? "application/xml" : "text/html" },
        customMetadata: { source, fetched_at: new Date().toISOString() },
      });
    }
    return key;
  } catch (e) {
    console.warn("archiveRaw failed", source, (e as Error).message);
    return undefined;
  }
}

export function clipSnippet(text: string, max = 480): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Task #5: the BraveHit type + braveSearch no-op were removed when the
// in-house crawler audit confirmed no callers remained.

export function apexDomain(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let host = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch { /* fallthrough */ }
  host = host.replace(/^www\./, "");
  // Two-label apex; preserve effective TLDs the cheap way (good enough
  // for prospect resolution — full PSL not worth the bundle weight here).
  const parts = host.split(".");
  if (parts.length <= 2) return host || undefined;
  // Common 2-part eTLDs we keep at 3 labels.
  const ccTwoPart = new Set(["co.uk","ac.uk","org.uk","gov.uk","com.au","co.jp","com.br","co.in","co.nz","com.sg","com.hk"]);
  const tail = parts.slice(-2).join(".");
  if (ccTwoPart.has(tail)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}
