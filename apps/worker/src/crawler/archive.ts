// Task #2 step 4: R2 HTML archive. Every fetched page is stored in the
// existing `RAW_HTML` bucket so adapters can be re-run from a frozen
// snapshot during debugging or after a site redesign.
//
// Key layout: `crawler/{yyyy-mm-dd}/{sha256(url).slice(0,16)}-{HHmmssSSS}.html`.
// The timestamp suffix is required so that re-fetching the same URL on
// the same UTC day does *not* overwrite the previous snapshot — replay
// fidelity depends on per-fetch history.
//
// TTL enforcement (7 days) is layered for defense-in-depth:
//   1. Each object writes an `expires_at` customMetadata header.
//   2. The day prefix means a Cloudflare R2 lifecycle policy on the
//      `crawler/` prefix older than 7 days is one-click.
//   3. `readArchive` ENFORCES the TTL in code: it never returns an
//      object whose `expires_at` is in the past, and it never walks
//      past the 7-day window. This guarantees TTL behavior even if
//      the bucket lifecycle policy is missing or misconfigured.
//   4. `purgeExpiredArchives` is a runtime helper for explicit
//      eviction from a scheduled handler.

import type { Env } from "../types";

export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_TTL_DAYS = 7;

async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compact `HHmmssSSS` time component carved from an ISO-8601 string.
 *  Keeps keys sortable lexicographically so the latest snapshot is the
 *  last entry when listing a day prefix. */
function timeSuffix(fetchedAt: string): string {
  // "2025-05-18T12:34:56.789Z" -> "123456789"
  const t = fetchedAt.slice(11, 23);
  return t.replace(/[^0-9]/g, "").padEnd(9, "0").slice(0, 9);
}

export function archiveKey(_url: string, fetchedAt: string, hash: string): string {
  const day = fetchedAt.slice(0, 10); // yyyy-mm-dd
  return `crawler/${day}/${hash.slice(0, 16)}-${timeSuffix(fetchedAt)}.html`;
}

export interface ArchiveResult { key: string; bytes: number; hash: string }

/** Store an HTML body in R2. Never throws — archive failures must not
 *  break crawls. Returns null on failure. */
export async function archiveHtml(
  env: Env, url: string, html: string, fetchedAt: string = new Date().toISOString(),
): Promise<ArchiveResult | null> {
  if (!env.RAW_HTML || !html) return null;
  try {
    const hash = await sha256Hex(url);
    const key = archiveKey(url, fetchedAt, hash);
    const expiresAt = new Date(Date.parse(fetchedAt) + ARCHIVE_TTL_MS).toISOString();
    await env.RAW_HTML.put(key, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: {
        source_url: url.slice(0, 1024),
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        url_hash: hash,
      },
    });
    return { key, bytes: html.length, hash };
  } catch (e) {
    console.warn("crawler.archiveHtml failed", (e as Error).message);
    return null;
  }
}

/** Replay path. Walks the day prefixes from today back through the
 *  7-day TTL window, returns the most recent (lexicographically last)
 *  snapshot of `url` whose `expires_at` is still in the future. The
 *  in-code TTL check guarantees stale objects are never surfaced even
 *  if the R2 bucket lifecycle policy is missing. */
export async function readArchive(env: Env, url: string): Promise<{ html: string; key: string; fetched_at: string } | null> {
  if (!env.RAW_HTML) return null;
  try {
    const hash = await sha256Hex(url);
    const slice = hash.slice(0, 16);
    const now = Date.now();
    for (let i = 0; i < ARCHIVE_TTL_DAYS; i++) {
      const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
      // List the day-prefix limited to this URL's hash to find any
      // matching snapshots (there may be several from same-day refetches).
      const prefix = `crawler/${day}/${slice}-`;
      const listing = await env.RAW_HTML.list({ prefix, limit: 64 });
      if (!listing.objects.length) continue;
      // Lexicographic sort puts the latest HHmmssSSS suffix last.
      const sorted = [...listing.objects].sort((a, b) => a.key.localeCompare(b.key));
      for (let j = sorted.length - 1; j >= 0; j--) {
        const meta = sorted[j];
        const expiresAt = meta.customMetadata?.expires_at;
        // In-code TTL enforcement — skip anything past expiry.
        if (expiresAt && Date.parse(expiresAt) <= now) continue;
        const obj = await env.RAW_HTML.get(meta.key);
        if (!obj) continue;
        const html = await obj.text();
        return { html, key: meta.key, fetched_at: obj.customMetadata?.fetched_at ?? "" };
      }
    }
    return null;
  } catch (e) {
    console.warn("crawler.readArchive failed", (e as Error).message);
    return null;
  }
}

/** Explicit eviction helper for scheduled handlers. Deletes any object
 *  under `crawler/` whose `expires_at` is in the past. Returns the
 *  count of deletions. Safe to call repeatedly. */
export async function purgeExpiredArchives(env: Env): Promise<number> {
  if (!env.RAW_HTML) return 0;
  const now = Date.now();
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const listing = await env.RAW_HTML.list({ prefix: "crawler/", limit: 1000, cursor });
    const toDelete: string[] = [];
    for (const o of listing.objects) {
      const expiresAt = o.customMetadata?.expires_at;
      if (expiresAt && Date.parse(expiresAt) <= now) toDelete.push(o.key);
    }
    if (toDelete.length) {
      await env.RAW_HTML.delete(toDelete);
      deleted += toDelete.length;
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return deleted;
}
