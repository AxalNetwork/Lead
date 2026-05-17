// Task #6: Crawler → news_items ingestion path.
//
// When the page classifier flags a crawled URL as news_article /
// blog_post / press_release, the URL crawler routes it here instead of
// creating an entity row. We extract whatever metadata the page exposes
// (title, byline, published_at) and persist a news_items stub. The
// downstream news-enrichment workflow (news/enrich.ts) can later fill
// in summary, sentiment, mentions, etc. — this helper deliberately
// stays cheap and synchronous so the crawler hot path isn't slowed.

import type { Env } from "../types";
import { getReputability, normalizeHost } from "./reputability";

export interface IngestNewsResult {
  ok: boolean;
  newsItemId: string | null;
  inserted: boolean;
  reason?: string;
}

function headSlice(html: string): string {
  const idx = html.toLowerCase().indexOf("</head>");
  return idx > 0 ? html.slice(0, idx + 7) : html.slice(0, 32_000);
}

function metaContent(head: string, attr: "property" | "name", key: string): string | null {
  const rx = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']`, "i");
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`, "i");
  const m = head.match(rx) ?? head.match(alt);
  return m ? m[1].trim() : null;
}

function pickTitle(html: string): string | null {
  const head = headSlice(html);
  const og = metaContent(head, "property", "og:title");
  if (og) return og.slice(0, 500);
  const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return t[1].replace(/\s+/g, " ").trim().slice(0, 500);
  return null;
}

function pickByline(html: string): string | null {
  const head = headSlice(html);
  return (
    metaContent(head, "name", "author") ||
    metaContent(head, "property", "article:author") ||
    null
  );
}

function pickPublishedAt(html: string): string | null {
  const head = headSlice(html);
  const raw =
    metaContent(head, "property", "article:published_time") ||
    metaContent(head, "name", "pubdate") ||
    metaContent(head, "name", "date") ||
    metaContent(head, "property", "og:updated_time") ||
    null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.valueOf()) ? null : d.toISOString();
}

function pickSourceName(html: string, host: string): string {
  const head = headSlice(html);
  return metaContent(head, "property", "og:site_name") || host;
}

function pickDescription(html: string): string | null {
  const head = headSlice(html);
  const d =
    metaContent(head, "property", "og:description") ||
    metaContent(head, "name", "description") ||
    null;
  return d ? d.slice(0, 1000) : null;
}

function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Strip tracking params that produce duplicate rows.
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src"];
    for (const k of drop) u.searchParams.delete(k);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Persist a news_items row for a freshly-crawled page that the page
 * classifier flagged as news-like. Idempotent: dedupes on
 * `url`/`url_canonical` and returns `{inserted:false}` if the row
 * already exists.
 */
export async function ingestNewsPage(
  env: Env,
  fetchedUrl: string,
  html: string,
  opts: { language?: string | null } = {},
): Promise<IngestNewsResult> {
  let host: string;
  try {
    host = normalizeHost(fetchedUrl);
  } catch {
    return { ok: false, newsItemId: null, inserted: false, reason: "bad_url" };
  }
  const canonical = canonicalizeUrl(fetchedUrl);

  const existing = await env.DB.prepare(
    `SELECT id FROM news_items WHERE url = ?1 OR url_canonical = ?2 LIMIT 1`,
  ).bind(fetchedUrl, canonical).first<{ id: string }>();
  if (existing?.id) {
    return { ok: true, newsItemId: existing.id, inserted: false, reason: "duplicate" };
  }

  const title = pickTitle(html);
  const byline = pickByline(html);
  const published = pickPublishedAt(html);
  const sourceName = pickSourceName(html, host);
  const excerpt = pickDescription(html);
  const rep = await getReputability(env, host);
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO news_items(id, url, url_canonical, host, title, headline, byline,
                              published_at, source_name, source_reputability, language, body_excerpt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, fetchedUrl, canonical, host, title, title, byline,
      published, sourceName, rep.score, opts.language ?? null, excerpt,
    ).run();
    return { ok: true, newsItemId: id, inserted: true };
  } catch (e) {
    // Lost a race with a concurrent insert (UNIQUE on url) — treat as dupe.
    const msg = (e as Error).message ?? "";
    if (/UNIQUE/i.test(msg)) {
      // Race recovery must mirror the pre-check (url OR url_canonical)
      // so that a canonical-only collision (two tracker variants of
      // the same article racing) still returns the existing id.
      const row = await env.DB.prepare(
        `SELECT id FROM news_items WHERE url = ?1 OR url_canonical = ?2 LIMIT 1`,
      ).bind(fetchedUrl, canonical).first<{ id: string }>();
      return { ok: true, newsItemId: row?.id ?? null, inserted: false, reason: "race_duplicate" };
    }
    return { ok: false, newsItemId: null, inserted: false, reason: msg };
  }
}
