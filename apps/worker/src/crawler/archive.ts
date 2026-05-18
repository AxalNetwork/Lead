// Task #2 step 4: R2 HTML archive. Every fetched page is stored in the
// existing `RAW_HTML` bucket so adapters can be re-run from a frozen
// snapshot during debugging or after a site redesign.
//
// Key layout: `crawler/{yyyy-mm-dd}/{sha256(url).slice(0,16)}.html`.
// Date-prefixing makes a lifecycle policy that drops the `crawler/`
// prefix older than 7 days trivial (configure once in the Cloudflare
// dashboard — we record an `expires_at` custom-metadata header for
// safety so manual cleanup is also one query). We also keep the
// `fetched_at` and original URL on the object so a replay tool can
// reconstruct context without round-tripping via D1.

import type { Env } from "../types";

const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function archiveKey(_url: string, fetchedAt: string, hash: string): string {
  const day = fetchedAt.slice(0, 10); // yyyy-mm-dd
  return `crawler/${day}/${hash.slice(0, 16)}.html`;
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

/** Replay path. Returns the HTML stored under the most recent archive
 *  key for `url` within the TTL window, or null. */
export async function readArchive(env: Env, url: string): Promise<{ html: string; key: string; fetched_at: string } | null> {
  if (!env.RAW_HTML) return null;
  try {
    const hash = await sha256Hex(url);
    // Walk back up to 7 days looking for the most recent snapshot.
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      const day = new Date(now - i * 86400_000).toISOString().slice(0, 10);
      const key = `crawler/${day}/${hash.slice(0, 16)}.html`;
      const obj = await env.RAW_HTML.get(key);
      if (obj) {
        const html = await obj.text();
        return { html, key, fetched_at: obj.customMetadata?.fetched_at ?? "" };
      }
    }
    return null;
  } catch (e) {
    console.warn("crawler.readArchive failed", (e as Error).message);
    return null;
  }
}
