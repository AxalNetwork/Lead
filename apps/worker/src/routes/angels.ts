// Task #4: Angel & Syndicate API routes.
//
//   GET /api/angels                     — paginated angel directory
//   GET /api/angels/operator-experts    — angels with domain expertise ⊇ ?domain=
//   GET /api/angels/:id/portfolio       — disclosed investments + co-investors
//   GET /api/syndicates/active          — syndicates by velocity / focus / geo
//
// All routes mount under /api/* (accessGuard) in index.ts. Angels data
// is platform-global; no per-operator owner column.

import { Hono } from "hono";
import type { Env } from "../types";
import type { AngelRow, SyndicateRow } from "../services/angels/types";
import { syndicateOverlap } from "../services/angels/syndicateAnalytics";

type Vars = { email: string; is_admin: boolean };

export const angelsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const syndicatesRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

const ANGEL_COLS = `person_entity_id, angel_type, classifier_confidence,
  day_job_entity_id, day_job_role,
  typical_check_min_usd, typical_check_max_usd,
  preferred_stages_json, preferred_sectors_json, preferred_geos_json,
  portfolio_count, disclosed_investments_count,
  syndicate_handle, rolling_fund_handle, domain_expertise_tags_json,
  last_investment_at, open_to_warm_intros, source_evidence_json,
  confidence, updated_at, created_at, last_refreshed_at`;

const SYND_COLS = `handle, display_name, lead_angel_entity_id,
  focus_sectors_json, focus_stages_json, geos_json,
  backer_count, deals_count, last_deal_at,
  avg_raise_usd, median_check_usd, velocity_per_quarter,
  source_evidence_json, updated_at, created_at`;

function clampLimit(raw: string | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function shapeAngel(row: AngelRow) {
  return {
    person_entity_id: row.person_entity_id,
    angel_type: row.angel_type,
    classifier_confidence: row.classifier_confidence,
    day_job_entity_id: row.day_job_entity_id,
    day_job_role: row.day_job_role,
    typical_check_min_usd: row.typical_check_min_usd,
    typical_check_max_usd: row.typical_check_max_usd,
    preferred_stages: safeJson<string[]>(row.preferred_stages_json) ?? [],
    preferred_sectors: safeJson<string[]>(row.preferred_sectors_json) ?? [],
    preferred_geos: safeJson<string[]>(row.preferred_geos_json) ?? [],
    portfolio_count: row.portfolio_count,
    disclosed_investments_count: row.disclosed_investments_count,
    syndicate_handle: row.syndicate_handle,
    rolling_fund_handle: row.rolling_fund_handle,
    domain_expertise_tags: safeJson<Array<{ tag: string; source: string }>>(row.domain_expertise_tags_json) ?? [],
    last_investment_at: row.last_investment_at,
    open_to_warm_intros: row.open_to_warm_intros === 1,
    source_evidence: safeJson<unknown[]>(row.source_evidence_json) ?? [],
    confidence: row.confidence,
    updated_at: row.updated_at,
  };
}

function shapeSyndicate(row: SyndicateRow) {
  return {
    handle: row.handle,
    display_name: row.display_name,
    lead_angel_entity_id: row.lead_angel_entity_id,
    focus_sectors: safeJson<string[]>(row.focus_sectors_json) ?? [],
    focus_stages: safeJson<string[]>(row.focus_stages_json) ?? [],
    geos: safeJson<string[]>(row.geos_json) ?? [],
    backer_count: row.backer_count,
    deals_count: row.deals_count,
    last_deal_at: row.last_deal_at,
    avg_raise_usd: row.avg_raise_usd,
    median_check_usd: row.median_check_usd,
    velocity_per_quarter: row.velocity_per_quarter,
    source_evidence: safeJson<unknown[]>(row.source_evidence_json) ?? [],
    updated_at: row.updated_at,
  };
}

// ---------------- GET /api/angels/operator-experts ----------------
// MUST be declared BEFORE /:id/portfolio so /operator-experts isn't
// shadowed by the param route.
angelsRoute.get("/operator-experts", async (c) => {
  const domain = (c.req.query("domain") ?? "").toLowerCase().trim();
  if (!domain) return c.json({ error: "domain query param required" }, 400);
  const limit = clampLimit(c.req.query("limit"));
  // domain_expertise_tags_json is JSON like [{"tag":"fintech","source":"day_job_firm"}]
  // A simple LIKE on the tag string is sufficient and index-friendly.
  const rows = await c.env.DB.prepare(
    `SELECT ${ANGEL_COLS} FROM angels
      WHERE angel_type = 'operator_angel'
        AND lower(COALESCE(domain_expertise_tags_json, '')) LIKE ?
      ORDER BY last_investment_at DESC NULLS LAST
      LIMIT ?`,
  ).bind(`%"tag":"${domain}"%`, limit).all<AngelRow>();
  return c.json({
    domain,
    total: (rows.results ?? []).length,
    angels: (rows.results ?? []).map(shapeAngel),
  });
});

// ---------------- GET /api/angels ----------------
angelsRoute.get("/", async (c) => {
  const checkMin = c.req.query("check_size_min");
  const checkMax = c.req.query("check_size_max");
  const sector   = c.req.query("sector");
  const geo      = c.req.query("geo");
  const angelType = c.req.query("angel_type");
  const openToWarm = c.req.query("open_to_warm_intros");
  const limit = clampLimit(c.req.query("limit"));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  const where: string[] = ["1=1"];
  const binds: unknown[] = [];
  if (checkMin) { where.push("COALESCE(typical_check_max_usd, typical_check_min_usd, 0) >= ?"); binds.push(Number(checkMin)); }
  if (checkMax) { where.push("COALESCE(typical_check_min_usd, typical_check_max_usd, 0) <= ?"); binds.push(Number(checkMax)); }
  if (sector)   { where.push("lower(COALESCE(preferred_sectors_json, '')) LIKE ?"); binds.push(`%${sector.toLowerCase()}%`); }
  if (geo)      { where.push("lower(COALESCE(preferred_geos_json, '')) LIKE ?"); binds.push(`%${geo.toLowerCase()}%`); }
  if (angelType) { where.push("angel_type = ?"); binds.push(angelType); }
  if (openToWarm === "true" || openToWarm === "1") { where.push("open_to_warm_intros = 1"); }

  const rows = await c.env.DB.prepare(
    `SELECT ${ANGEL_COLS} FROM angels
      WHERE ${where.join(" AND ")}
      ORDER BY last_investment_at DESC NULLS LAST
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<AngelRow>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM angels WHERE ${where.join(" AND ")}`,
  ).bind(...binds).first<{ n: number }>();
  return c.json({
    total: total?.n ?? 0,
    limit, offset,
    angels: (rows.results ?? []).map(shapeAngel),
  });
});

// ---------------- GET /api/angels/:id/portfolio ----------------
angelsRoute.get("/:id/portfolio", async (c) => {
  const id = c.req.param("id");
  const angel = await c.env.DB.prepare(
    `SELECT ${ANGEL_COLS} FROM angels WHERE person_entity_id = ?`,
  ).bind(id).first<AngelRow>();
  if (!angel) return c.json({ error: "not_found" }, 404);

  const invRes = await c.env.DB.prepare(
    `SELECT id, company_entity_id, company_name_raw, amount_usd, round_name,
            role, via_syndicate_handle, announced_at, source_url, source_type,
            dedupe_key, deal_event_id, confidence
       FROM angel_investments
      WHERE person_entity_id = ?
      ORDER BY announced_at DESC NULLS LAST
      LIMIT 500`,
  ).bind(id).all<{
    id: string; company_entity_id: string | null; company_name_raw: string;
    amount_usd: number | null; round_name: string | null; role: string;
    via_syndicate_handle: string | null; announced_at: string | null;
    source_url: string | null; source_type: string | null;
    dedupe_key: string; deal_event_id: string | null; confidence: number;
  }>();
  const investments = invRes.results ?? [];

  // Co-investors: every other person who participated in the same deals.
  let coInvestors: Array<{ person_entity_id: string; display_name: string | null; shared_deal_count: number }> = [];
  const dealIds = investments.map((i) => i.deal_event_id).filter((x): x is string => !!x);
  if (dealIds.length > 0) {
    const placeholders = dealIds.map(() => "?").join(",");
    const coRes = await c.env.DB.prepare(
      `SELECT u.id AS person_entity_id, u.display_name, COUNT(*) AS shared_deal_count
         FROM deal_participants p
         JOIN u_entities u ON u.id = p.investor_entity_id
        WHERE p.deal_id IN (${placeholders})
          AND u.kind = 'person'
          AND u.id != ?
        GROUP BY u.id, u.display_name
        ORDER BY shared_deal_count DESC
        LIMIT 100`,
    ).bind(...dealIds, id).all<{ person_entity_id: string; display_name: string | null; shared_deal_count: number }>();
    coInvestors = coRes.results ?? [];
  }

  return c.json({
    angel: shapeAngel(angel),
    investments,
    co_investors: coInvestors,
  });
});

// ---------------- GET /api/syndicates/active ----------------
syndicatesRoute.get("/active", async (c) => {
  const focus = c.req.query("focus");
  const minVelocity = Number(c.req.query("min_velocity") ?? 0);
  const geo = c.req.query("geo");
  const limit = clampLimit(c.req.query("limit"));
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString().slice(0, 10);

  const where: string[] = ["COALESCE(last_deal_at, '') >= ?"];
  const binds: unknown[] = [cutoff];
  if (Number.isFinite(minVelocity) && minVelocity > 0) {
    where.push("COALESCE(velocity_per_quarter, 0) >= ?");
    binds.push(minVelocity);
  }
  if (focus) { where.push("lower(COALESCE(focus_sectors_json, '')) LIKE ?"); binds.push(`%${focus.toLowerCase()}%`); }
  if (geo)   { where.push("lower(COALESCE(geos_json, '')) LIKE ?"); binds.push(`%${geo.toLowerCase()}%`); }

  const rows = await c.env.DB.prepare(
    `SELECT ${SYND_COLS} FROM syndicates
      WHERE ${where.join(" AND ")}
      ORDER BY velocity_per_quarter DESC, last_deal_at DESC
      LIMIT ?`,
  ).bind(...binds, limit).all<SyndicateRow>();
  return c.json({
    total: (rows.results ?? []).length,
    cutoff_last_deal_at: cutoff,
    min_velocity_per_quarter: minVelocity,
    syndicates: (rows.results ?? []).map(shapeSyndicate),
  });
});

// ---------------- GET /api/syndicates/:handle/overlap?with=... ----------------
syndicatesRoute.get("/:handle/overlap", async (c) => {
  const a = c.req.param("handle");
  const b = c.req.query("with");
  if (!b) return c.json({ error: "with query param required" }, 400);
  const result = await syndicateOverlap(c.env, a, b);
  return c.json(result);
});
