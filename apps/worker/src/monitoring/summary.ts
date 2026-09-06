// Canonical entity-summary projection + fingerprint.
//
// `buildCanonicalSummary` reads from the rollup tables produced by the
// rest of the platform (`entity_summary`, `u_entities`, plus a handful
// of side-tables for derived counts). The projection is intentionally
// narrow and stable — bump `SUMMARY_SCHEMA_VERSION` if you add or
// remove a field, so the monitor knows to skip the first delta after
// the schema bump and avoid a notification storm.

import type { Env } from "../types";

export const SUMMARY_SCHEMA_VERSION = 1;

export interface CanonicalSummary {
  schema_version: number;
  entity_id: string;
  kind: string | null;
  display_name: string | null;
  employer: string | null;
  employer_entity_id: string | null;
  title: string | null;
  role: string | null;
  city: string | null;
  country: string | null;
  sectors: string[];
  stages: string[];
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  portfolio_count: number;
  last_news_at: string | null;
  last_post_at: string | null;
  handles_count: number;
  dd_risk_score: number | null;
  dd_findings_by_severity: { low: number; medium: number; high: number; critical: number };
  trust_score: number | null;
  fit_max_score: number | null;
  intent_score: number | null;
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function csv(v: unknown): string[] {
  const t = s(v);
  if (!t) return [];
  return t.split(",").map((x) => x.trim()).filter(Boolean).sort();
}

async function safeCount(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

async function safeFirst<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return await env.DB.prepare(sql).bind(...binds).first<T>();
  } catch {
    return null;
  }
}

/**
 * Build the canonical summary for one entity. Returns null when the
 * entity row is missing.
 */
export async function buildCanonicalSummary(env: Env, entityId: string): Promise<CanonicalSummary | null> {
  const ent = await safeFirst<{
    id: string; kind: string | null; display_name: string | null;
  }>(env, `SELECT id, kind, display_name FROM u_entities WHERE id = ?`, entityId);
  if (!ent) return null;

  const sum = await safeFirst<{
    primary_role: string | null;
    primary_employer: string | null;
    primary_employer_entity_id: string | null;
    country_iso2: string | null;
    region: string | null;
    city: string | null;
    sectors_csv: string | null;
    stages_csv: string | null;
    check_size_min_usd: number | null;
    check_size_max_usd: number | null;
    fit_max_score: number | null;
    intent_score: number | null;
    quality_score: number | null;
  }>(env, `SELECT primary_role, primary_employer, primary_employer_entity_id, country_iso2, region, city,
                  sectors_csv, stages_csv, check_size_min_usd, check_size_max_usd,
                  fit_max_score, intent_score, quality_score
             FROM entity_summary WHERE entity_id = ?`, entityId);

  // Title is a fact, not a column on entity_summary.
  const titleRow = await safeFirst<{ v: string | null }>(
    env,
    `SELECT value_text AS v FROM facts WHERE entity_id = ? AND predicate = 'title' AND is_current = 1
        ORDER BY confidence DESC, observed_at DESC LIMIT 1`,
    entityId,
  );

  // Portfolio / handle / news counts. Use defensive try/count — these
  // side-tables exist only in certain deployments.
  const portfolio = await safeCount(
    env,
    `SELECT COUNT(*) AS n FROM investor_investments WHERE investor_entity_id = ?`,
    entityId,
  );
  const handles = await safeCount(
    env,
    `SELECT COUNT(*) AS n FROM identity_handles WHERE entity_id = ?`,
    entityId,
  );

  const lastNews = await safeFirst<{ t: string | null }>(
    env,
    `SELECT MAX(ni.published_at) AS t
       FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ?`,
    entityId,
  );

  const lastPost = await safeFirst<{ t: string | null }>(
    env,
    `SELECT MAX(observed_at) AS t FROM facts WHERE entity_id = ?
       AND predicate IN ('last_tweet_at','last_post_at') AND is_current = 1`,
    entityId,
  );

  // DD risk + findings severity buckets.
  const dd = await safeFirst<{ score: number | null }>(
    env,
    `SELECT risk_score AS score FROM dd_entity_state WHERE entity_id = ?`,
    entityId,
  );
  const ddRiskScore = dd?.score ?? null;

  const sev = { low: 0, medium: 0, high: 0, critical: 0 };
  try {
    const rows = await env.DB
      .prepare(`SELECT severity, COUNT(*) AS n FROM dd_findings WHERE entity_id = ? AND reviewed_at IS NULL GROUP BY severity`)
      .bind(entityId)
      .all<{ severity: string; n: number }>();
    for (const r of rows.results ?? []) {
      const sevKey = String(r.severity ?? "").toLowerCase();
      if (sevKey === "low" || sevKey === "medium" || sevKey === "high" || sevKey === "critical") {
        sev[sevKey] = Number(r.n) || 0;
      }
    }
  } catch { /* table missing — leave zeros */ }

  // trust_score is a monitored field (monitoring/diff.ts watches it), so it
  // needs a real column. It was read as `influence_score` off a
  // profile-axes table — no table in the schema has that column at all; the
  // only influence_score belongs to `buyers`. entity_risk_scores is where a
  // per-entity trust_score actually lives (migrations/215_dd.sql).
  const trust = await safeFirst<{ v: number | null }>(
    env,
    `SELECT trust_score AS v FROM entity_risk_scores WHERE entity_id = ?`,
    entityId,
  );

  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    entity_id: ent.id,
    kind: s(ent.kind),
    display_name: s(ent.display_name),
    employer: s(sum?.primary_employer ?? null),
    employer_entity_id: s(sum?.primary_employer_entity_id ?? null),
    title: s(titleRow?.v ?? null),
    role: s(sum?.primary_role ?? null),
    city: s(sum?.city ?? null),
    country: s(sum?.country_iso2 ?? null),
    sectors: csv(sum?.sectors_csv ?? null),
    stages: csv(sum?.stages_csv ?? null),
    check_size_min_usd: n(sum?.check_size_min_usd ?? null),
    check_size_max_usd: n(sum?.check_size_max_usd ?? null),
    portfolio_count: portfolio,
    last_news_at: s(lastNews?.t ?? null),
    last_post_at: s(lastPost?.t ?? null),
    handles_count: handles,
    dd_risk_score: n(ddRiskScore),
    dd_findings_by_severity: sev,
    trust_score: n(trust?.v ?? null),
    fit_max_score: n(sum?.fit_max_score ?? null),
    intent_score: n(sum?.intent_score ?? null),
  };
}

/**
 * Stable JSON serialization — keys sorted at every level so the hash
 * never spuriously changes due to property ordering.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintSummary(summary: CanonicalSummary): Promise<string> {
  return sha256Hex(canonicalJson(summary));
}

/**
 * Load the most recent snapshot for an entity. Returns null if none yet.
 */
export async function loadLatestSnapshot(env: Env, entityId: string): Promise<{
  summary: CanonicalSummary;
  hash: string;
  schema_version: number;
  snapshot_at: string;
} | null> {
  const r = await safeFirst<{
    summary_json: string; summary_hash: string; schema_version: number; snapshot_at: string;
  }>(env, `SELECT summary_json, summary_hash, schema_version, snapshot_at
             FROM entity_snapshots WHERE entity_id = ?
             ORDER BY snapshot_at DESC LIMIT 1`, entityId);
  if (!r) return null;
  try {
    return {
      summary: JSON.parse(r.summary_json) as CanonicalSummary,
      hash: r.summary_hash,
      schema_version: r.schema_version,
      snapshot_at: r.snapshot_at,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a snapshot. UNIQUE(entity_id, summary_hash) makes this a no-op
 * when the fingerprint has not changed.
 */
export async function persistSnapshot(
  env: Env,
  entityId: string,
  summary: CanonicalSummary,
  hash: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO entity_snapshots (id, entity_id, summary_json, summary_hash, schema_version, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, entityId, JSON.stringify(summary), hash, summary.schema_version, new Date().toISOString())
    .run();
}
