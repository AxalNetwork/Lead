// Task #2: Wikipedia / Wikidata cross-reference.
//
// For each u_entity we:
//   1. Search Wikidata via `wbsearchentities` for the display_name.
//   2. If a hit exists, follow the sitelink to en.wikipedia.org.
//   3. Fetch the REST HTML and parse the infobox — every key/value pair
//      becomes a fact with source_kind='wikipedia'. Existing facts are
//      not overwritten; we add a confirming citation instead.
//   4. A persistent news_item record is created for the wiki article so
//      the fact_citations FK is honoured and the article surfaces in
//      the News tab.

import type { Env } from "../types";
import { recomputeVerifiedScore } from "./citations";

const UA = "AIDataSignal/1.0 (+https://aidatasignal.com)";
const REST_BASE = "https://en.wikipedia.org/api/rest_v1/page/html/";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

interface WdSearchHit { id: string; label?: string; description?: string; concepturi?: string }

async function searchWikidata(name: string): Promise<WdSearchHit | null> {
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=5&origin=*`;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { search?: WdSearchHit[] };
    return data.search?.[0] ?? null;
  } catch { return null; }
}

async function wikipediaTitleForWikidata(qid: string): Promise<string | null> {
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }> };
    const ent = Object.values(data.entities ?? {})[0];
    return ent?.sitelinks?.enwiki?.title ?? null;
  } catch { return null; }
}

async function fetchWikiHtml(title: string): Promise<string | null> {
  try {
    const res = await fetch(`${REST_BASE}${encodeURIComponent(title)}`, { headers: { "user-agent": UA, accept: "text/html" } });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

// Parse the first <table class="infobox"> — return key/value pairs.
export function parseInfobox(html: string): Array<{ key: string; value: string }> {
  const m = html.match(/<table[^>]*class="[^"]*infobox[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return [];
  const rows: Array<{ key: string; value: string }> = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const r of m[1].matchAll(rowRe)) {
    const th = r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const td = r[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!th || !td) continue;
    const key = stripHtml(th[1]).toLowerCase().replace(/\s+/g, "_").slice(0, 40);
    const value = stripHtml(td[1]).slice(0, 240);
    if (!key || !value) continue;
    rows.push({ key, value });
  }
  return rows;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

// Map common infobox keys to canonical fact predicates.
const KEY_MAP: Record<string, string> = {
  "founded": "founded",
  "founder": "founder_of",
  "founders": "founder_of",
  "headquarters": "hq",
  "headquarters_location": "hq",
  "based_in": "hq",
  "industry": "sector",
  "assets_under_management": "fund_aum_usd",
  "aum": "fund_aum_usd",
  "born": "born",
  "birth_date": "born",
  "education": "education",
  "alma_mater": "education",
  "occupation": "role",
  "employer": "employer",
  "title": "title",
  "known_for": "known_for",
  "spouse": "spouse",
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns the news_item id for the wiki article, creating one if needed.
async function upsertWikiNewsItem(env: Env, title: string, articleUrl: string, summary: string): Promise<string> {
  const existing = await env.DB.prepare(`SELECT id FROM news_items WHERE url = ?`).bind(articleUrl).first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO news_items(id, url, host, title, headline, source_name, source_reputability, language, summary, fetched_at, archive_url, archive_date)
     VALUES(?, ?, 'en.wikipedia.org', ?, ?, 'Wikipedia', 0.85, 'en', ?, datetime('now'), ?, datetime('now'))`,
  ).bind(id, articleUrl, title, title, summary.slice(0, 500), articleUrl).run();
  return id;
}

export interface WikiXrefResult {
  matched: boolean;
  qid?: string;
  title?: string;
  url?: string;
  facts_added: number;
  citations_added: number;
}

export async function crossReferenceEntity(env: Env, entityId: string, displayName: string): Promise<WikiXrefResult> {
  if (!displayName) return { matched: false, facts_added: 0, citations_added: 0 };
  const hit = await searchWikidata(displayName);
  if (!hit) return { matched: false, facts_added: 0, citations_added: 0 };
  const wikiTitle = await wikipediaTitleForWikidata(hit.id);
  if (!wikiTitle) return { matched: false, facts_added: 0, citations_added: 0 };
  const articleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}`;
  const html = await fetchWikiHtml(wikiTitle);
  if (!html) return { matched: true, qid: hit.id, title: wikiTitle, url: articleUrl, facts_added: 0, citations_added: 0 };
  const rows = parseInfobox(html);
  const summary = hit.description ?? wikiTitle;
  const newsId = await upsertWikiNewsItem(env, wikiTitle, articleUrl, summary);

  let factsAdded = 0;
  let citationsAdded = 0;
  const touchedFactIds: string[] = [];
  for (const r of rows) {
    const predicate = KEY_MAP[r.key] ?? null;
    if (!predicate) continue;
    const existing = await env.DB.prepare(
      `SELECT id FROM facts WHERE entity_id = ? AND predicate = ? AND is_current = 1 LIMIT 1`,
    ).bind(entityId, predicate).first<{ id: string }>();
    let factId: string;
    if (existing?.id) {
      factId = existing.id;
    } else {
      factId = crypto.randomUUID();
      const hash = await sha256Hex(`${entityId}|${predicate}|${r.value}|wikipedia|${articleUrl}`);
      try {
        // Wikipedia facts carry a +0.15 verified_score bonus baked in.
        await env.DB.prepare(
          `INSERT INTO facts(id, entity_id, predicate, value_text, source_kind, source, evidence_url, confidence, hash, is_current, verified_score)
           VALUES(?, ?, ?, ?, 'wikipedia', 'wikipedia.infobox', ?, 0.85, ?, 1, 0.15)`,
        ).bind(factId, entityId, predicate, r.value, articleUrl, hash).run();
        factsAdded++;
      } catch {
        const dup = await env.DB.prepare(`SELECT id FROM facts WHERE hash = ?`).bind(hash).first<{ id: string }>();
        if (dup?.id) factId = dup.id;
      }
    }
    // Insert citation (idempotent).
    const cid = crypto.randomUUID();
    const before = await env.DB.prepare(`SELECT id FROM fact_citations WHERE fact_id = ? AND news_item_id = ?`).bind(factId, newsId).first<{ id: string }>();
    if (!before) {
      await env.DB.prepare(
        `INSERT INTO fact_citations(id, fact_id, news_item_id, quote, contradicts)
         VALUES(?, ?, ?, ?, 0)`,
      ).bind(cid, factId, newsId, `Wikipedia infobox: ${r.key} = ${r.value}`.slice(0, 500)).run();
      citationsAdded++;
    }
    touchedFactIds.push(factId);
  }
  // Recompute verified_score for every touched fact (wiki bonus is additive).
  for (const fid of [...new Set(touchedFactIds)]) {
    const base = await recomputeVerifiedScore(env, fid);
    // Add +0.15 wiki bonus on top (clamped).
    const boosted = Math.min(1, base + 0.15);
    await env.DB.prepare(`UPDATE facts SET verified_score = ? WHERE id = ?`).bind(boosted, fid).run();
  }
  return { matched: true, qid: hit.id, title: wikiTitle, url: articleUrl, facts_added: factsAdded, citations_added: citationsAdded };
}
