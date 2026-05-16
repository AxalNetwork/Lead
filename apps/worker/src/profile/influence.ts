// Task #3: Derived influence axes (0..1, never AI).
//
// network_centrality  ← degree on rel_edges (capped, log-scaled)
// media_influence     ← Σ news_entity_mentions × source_reputability (log)
// capital_influence   ← log(Σ investor_investments.amount_usd + fund AUM facts)
// political_influence ← Σ government_appointments seniority + donation totals
//                       + PEP boolean
//
// Each axis is min-maxed against documented anchors so a brand-new
// entity with one mention doesn't read 0.9. Tuning is intentionally
// conservative — operators can rescale with classifier_version bumps.

import type { Env } from "../types";

export interface Influence {
  network_centrality: number;
  media_influence: number;
  capital_influence: number;
  political_influence: number;
}

const LOG_CAP_DEGREE = Math.log(200);   // ~degree 200 ⇒ 1.0
const LOG_CAP_MEDIA  = Math.log(500);   // weighted-mentions 500 ⇒ 1.0
const LOG_CAP_CAPITAL = Math.log(1e10); // $10B portfolio+AUM ⇒ 1.0
const POLITICAL_FULL = 25;              // seniority+donation score 25 ⇒ 1.0

function logScale(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const v = Math.log(1 + value) / cap;
  return Math.max(0, Math.min(1, v));
}

export async function computeInfluence(env: Env, entityId: string): Promise<Influence> {
  // ---- network_centrality ----
  const deg = await env.DB.prepare(
    `SELECT (
       (SELECT COUNT(*) FROM rel_edges WHERE src_entity_id = ?)
     + (SELECT COUNT(*) FROM rel_edges WHERE dst_entity_id = ?)
     ) AS deg`,
  ).bind(entityId, entityId).first<{ deg: number }>();
  const network = logScale(deg?.deg ?? 0, LOG_CAP_DEGREE);

  // ---- media_influence ----
  const med = await env.DB.prepare(
    `SELECT COALESCE(SUM(MAX(ni.source_reputability, 0.1) * MAX(nem.mention_count, 1)), 0) AS s
       FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ?`,
  ).bind(entityId).first<{ s: number }>();
  const media = logScale(med?.s ?? 0, LOG_CAP_MEDIA);

  // ---- capital_influence ----
  // investor_investments may reference the entity via investor_lead_id
  // (legacy lead id) or via a fact pointing at it. We try the legacy
  // path first; if zero we fall back to a fact predicate sum.
  let invest = 0;
  try {
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS s
         FROM investor_investments ii
         JOIN leads l ON l.id = ii.investor_lead_id
        WHERE l.id IN (SELECT lead_id FROM unified_links WHERE entity_id = ? AND lead_id IS NOT NULL)`,
    ).bind(entityId).first<{ s: number }>();
    invest = r?.s ?? 0;
  } catch { invest = 0; /* unified_links may not exist on every deploy */ }
  // AUM as a numeric fact
  const aum = await env.DB.prepare(
    `SELECT COALESCE(SUM(value_number), 0) AS s FROM facts WHERE entity_id = ? AND predicate IN ('fund_aum_usd', 'aum_usd')`,
  ).bind(entityId).first<{ s: number }>();
  const capital = logScale((invest ?? 0) + (aum?.s ?? 0), LOG_CAP_CAPITAL);

  // ---- political_influence ----
  const apptRows = await env.DB.prepare(
    `SELECT seniority, is_current FROM government_appointments WHERE entity_id = ?`,
  ).bind(entityId).all<{ seniority: number | null; is_current: number }>();
  let apptScore = 0;
  for (const a of apptRows.results ?? []) {
    const s = Math.max(1, Math.min(5, a.seniority ?? 1));
    apptScore += a.is_current ? s : s * 0.4;
  }
  const donTot = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM political_donations WHERE entity_id = ?`,
  ).bind(entityId).first<{ s: number }>();
  const donScore = Math.min(10, Math.log10(1 + (donTot?.s ?? 0))); // $1M ⇒ 6, $100k ⇒ 5
  const polRaw = apptScore + donScore;
  const political = Math.max(0, Math.min(1, polRaw / POLITICAL_FULL));

  return {
    network_centrality: round2(network),
    media_influence: round2(media),
    capital_influence: round2(capital),
    political_influence: round2(political),
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
