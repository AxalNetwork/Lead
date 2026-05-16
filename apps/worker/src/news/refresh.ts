// Task #2: News refresh orchestrator.
//
// refreshEntityNews(env, entityId, opts) is the single entry point used by:
//   - POST /api/news/refresh/:entityId
//   - EnrichLeadWorkflow (per-lead news refresh step)
//   - Nightly batch (daily cron, top-N entities by quality_score desc)
//
// Steps:
//   1. Look up the entity → display_name.
//   2. Fan out to every enabled provider (newsapi/gdelt/PRN/BW/regulators/congress/wikinews).
//   3. For each new URL: dedupe vs news_items.url, persist a stub row.
//   4. For each persisted row: enrich (NER + sentiment + summary), archive (Wayback),
//      insert news_entity_mentions, extract claims → fact_citations,
//      recompute verified_score on touched facts.
//   5. Cross-reference Wikipedia/Wikidata once per refresh.
//
// Per-entity per-day cap enforced via news_items.fetched_at lookup.

import type { Env } from "../types";
import { ensureSeeded, getReputability, normalizeHost } from "./reputability";
import { fanOutAllProviders, type NewsCandidate } from "./providers";
import { archiveUrl } from "./archive";
import { fetchAndSanitize, archiveRawHtml, enrichArticle, type NewsItemRow } from "./enrich";
import { extractClaims, persistCitationsForMention, recomputeVerifiedScore } from "./citations";
import { crossReferenceEntity } from "./wikipediaXref";

export interface RefreshResult {
  entity_id: string;
  display_name: string;
  candidates: number;
  persisted: number;
  enriched: number;
  mentions: number;
  citations: number;
  wiki: { matched: boolean; facts_added: number; citations_added: number };
  errors: string[];
}

const LANG_DEFAULT = "en";

function parseLangAllowlist(env: Env): Set<string> {
  const raw = env.NEWS_LANG_ALLOWLIST?.trim() || LANG_DEFAULT;
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function perEntityCap(env: Env): number {
  const n = Number(env.NEWS_REFRESH_PER_ENTITY_CAP || "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

async function todayPersistedCountForEntity(env: Env, entityId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ? AND date(ni.fetched_at) = date('now')`,
  ).bind(entityId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function refreshEntityNews(env: Env, entityId: string, opts: { archive?: boolean; wiki?: boolean; maxArticles?: number } = {}): Promise<RefreshResult> {
  await ensureSeeded(env);
  const ent = await env.DB.prepare(
    `SELECT id, display_name FROM u_entities WHERE id = ? AND status='active' LIMIT 1`,
  ).bind(entityId).first<{ id: string; display_name: string }>();
  if (!ent || !ent.display_name) {
    return { entity_id: entityId, display_name: "", candidates: 0, persisted: 0, enriched: 0, mentions: 0, citations: 0, wiki: { matched: false, facts_added: 0, citations_added: 0 }, errors: ["entity_not_found_or_no_name"] };
  }

  const langs = parseLangAllowlist(env);
  const cap = perEntityCap(env);
  const alreadyToday = await todayPersistedCountForEntity(env, entityId);
  const budget = Math.max(0, Math.min(opts.maxArticles ?? cap, cap - alreadyToday));
  const errors: string[] = [];
  const result: RefreshResult = {
    entity_id: ent.id, display_name: ent.display_name,
    candidates: 0, persisted: 0, enriched: 0, mentions: 0, citations: 0,
    wiki: { matched: false, facts_added: 0, citations_added: 0 },
    errors,
  };

  if (budget === 0) {
    errors.push("daily_cap_reached");
  } else {
    const candidates = await fanOutAllProviders(env, ent.display_name);
    result.candidates = candidates.length;
    const filtered = candidates.filter((c) => !c.language || langs.has(c.language.toLowerCase().slice(0, 2)));
    const limited = filtered.slice(0, budget);

    for (const cand of limited) {
      try {
        const persisted = await persistStubIfNew(env, cand);
        if (!persisted) continue;
        result.persisted++;

        const fetched = await fetchAndSanitize(cand.url);
        if (!fetched) {
          // Still link the entity to the stub via mention (low confidence).
          await linkMention(env, persisted.id, ent.id, cand.title ?? "", 0.6, 0);
          result.mentions++;
          continue;
        }
        // Archive raw HTML in R2.
        const bodyKey = await archiveRawHtml(env, persisted.host, fetched.raw);
        // Best-effort Wayback save.
        const archive = opts.archive === false ? { archive_url: null, archive_date: null } : await archiveUrl(env, cand.url);
        await env.DB.prepare(
          `UPDATE news_items SET body_excerpt = ?, body_r2_key = ?, archive_url = COALESCE(?, archive_url), archive_date = COALESCE(?, archive_date)
            WHERE id = ?`,
        ).bind(fetched.body.slice(0, 2048), bodyKey, archive.archive_url, archive.archive_date, persisted.id).run();

        const item: NewsItemRow = { id: persisted.id, url: cand.url, title: cand.title ?? null, host: persisted.host, language: cand.language ?? null };
        const enriched = await enrichArticle(env, item, fetched.body);
        result.enriched++;
        await env.DB.prepare(
          `UPDATE news_items SET summary = ?, sentiment = ? WHERE id = ?`,
        ).bind(enriched.summary, enriched.sentiment, persisted.id).run();

        // Insert mentions. Always include the subject entity (the one we
        // refreshed news for) even if NER missed it, with confidence 0.7.
        const subjectMention = enriched.mentions.find((m) => m.entity_id === ent.id);
        if (!subjectMention) {
          await linkMention(env, persisted.id, ent.id, cand.title ?? "", 0.7, 1);
          result.mentions++;
        }
        for (const m of enriched.mentions) {
          await env.DB.prepare(
            `INSERT INTO news_entity_mentions(id, news_item_id, entity_id, mention_count, context_quote, is_subject, sentiment_about_entity, confidence)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(news_item_id, entity_id) DO UPDATE SET
               mention_count = excluded.mention_count,
               context_quote = excluded.context_quote,
               is_subject = excluded.is_subject,
               sentiment_about_entity = excluded.sentiment_about_entity,
               confidence = excluded.confidence`,
          ).bind(crypto.randomUUID(), persisted.id, m.entity_id, m.mention_count, m.context_quote, m.is_subject, m.sentiment, m.confidence).run();
          result.mentions++;
        }

        // Extract claims for the subject entity and persist citations.
        const claims = await extractClaims(env, ent.display_name, fetched.body);
        if (claims.length > 0) {
          const touched = await persistCitationsForMention(env, persisted.id, ent.id, cand.url, claims);
          result.citations += touched.length;
          // Recompute verified_score for each touched fact.
          const unique = [...new Set(touched.map((t) => t.fact_id))];
          for (const fid of unique) await recomputeVerifiedScore(env, fid);
        }
      } catch (e) {
        errors.push(`enrich_failed:${cand.url}:${(e as Error).message}`);
      }
    }
  }

  // Wikipedia cross-reference (one shot per refresh).
  if (opts.wiki !== false) {
    try {
      result.wiki = await crossReferenceEntity(env, ent.id, ent.display_name);
    } catch (e) {
      errors.push(`wiki_xref:${(e as Error).message}`);
    }
  }
  return result;
}

async function persistStubIfNew(env: Env, cand: NewsCandidate): Promise<{ id: string; host: string } | null> {
  const host = normalizeHost(cand.url);
  const existing = await env.DB.prepare(`SELECT id FROM news_items WHERE url = ? LIMIT 1`).bind(cand.url).first<{ id: string }>();
  if (existing?.id) return { id: existing.id, host };
  const rep = await getReputability(env, host);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO news_items(id, url, url_canonical, host, title, headline, byline, published_at, source_name, source_reputability, language, body_excerpt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, cand.url, cand.url, host, cand.title, cand.headline, cand.byline, cand.published_at, cand.source_name ?? host, rep.score, cand.language, cand.snippet ?? null).run();
    return { id, host };
  } catch {
    const after = await env.DB.prepare(`SELECT id FROM news_items WHERE url = ? LIMIT 1`).bind(cand.url).first<{ id: string }>();
    return after?.id ? { id: after.id, host } : null;
  }
}

async function linkMention(env: Env, newsId: string, entityId: string, quote: string, confidence: number, isSubject: 0 | 1): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO news_entity_mentions(id, news_item_id, entity_id, mention_count, context_quote, is_subject, confidence)
     VALUES(?, ?, ?, 1, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), newsId, entityId, quote.slice(0, 300), isSubject, confidence).run();
}
