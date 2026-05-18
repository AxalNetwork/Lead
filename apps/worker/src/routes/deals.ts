// Task #3: Deal-aggregator API routes.
//
//   GET /api/deals                           — paginated deal index
//   GET /api/deals/recent?days=7             — weekly digest by event_type
//   GET /api/companies/:id/deal-history      — one company's chronological rounds
//   GET /api/investors/:id/deal-history      — one investor's deal participation
//
// All routes mount under /api/* (accessGuard) in apps/worker/src/index.ts.
// Deal data is platform-global; there is no per-operator owner column.

import { Hono } from "hono";
import type { Env } from "../types";

type Vars = { email: string; is_admin: boolean };

export const dealsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const companiesDealsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const investorsDealsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface DealRow {
  id: string;
  event_type: string;
  company_entity_id: string | null;
  company_name_raw: string;
  round_name: string | null;
  amount_usd: number | null;
  amount_raw: string | null;
  valuation_usd: number | null;
  valuation_type: string | null;
  announcement_date: string | null;
  closing_date: string | null;
  sector_tags_json: string | null;
  stage_tags_json: string | null;
  geography: string | null;
  use_of_proceeds: string | null;
  source_url: string | null;
  source_type: string | null;
  source_published_at: string | null;
  sources_json: string | null;
  confidence: number;
  status: string;
}

interface ParticipantRow {
  id: string;
  deal_id: string;
  investor_entity_id: string | null;
  investor_name_raw: string;
  role: string;
  position_usd: number | null;
  source_url: string | null;
  source_type: string | null;
  confidence: number;
}

function clampLimit(raw: string | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function shape(row: DealRow, participants: ParticipantRow[] = []) {
  return {
    id: row.id,
    event_type: row.event_type,
    company_entity_id: row.company_entity_id,
    company_name: row.company_name_raw,
    round_name: row.round_name,
    amount_usd: row.amount_usd,
    amount_raw: row.amount_raw,
    valuation_usd: row.valuation_usd,
    valuation_type: row.valuation_type,
    announcement_date: row.announcement_date,
    closing_date: row.closing_date,
    sector_tags: safeJson<string[]>(row.sector_tags_json) ?? [],
    stage_tags: safeJson<string[]>(row.stage_tags_json) ?? [],
    geography: row.geography,
    use_of_proceeds: row.use_of_proceeds,
    source_url: row.source_url,
    source_type: row.source_type,
    source_published_at: row.source_published_at,
    sources: safeJson<unknown[]>(row.sources_json) ?? [],
    confidence: row.confidence,
    status: row.status,
    participants: participants
      .filter((p) => p.deal_id === row.id)
      .map((p) => ({
        investor_entity_id: p.investor_entity_id,
        investor_name: p.investor_name_raw,
        role: p.role,
        position_usd: p.position_usd,
        confidence: p.confidence,
      })),
  };
}

async function loadParticipants(env: Env, dealIds: string[]): Promise<ParticipantRow[]> {
  if (!dealIds.length) return [];
  const placeholders = dealIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, deal_id, investor_entity_id, investor_name_raw, role,
            position_usd, source_url, source_type, confidence
       FROM deal_participants
      WHERE deal_id IN (${placeholders})`,
  ).bind(...dealIds).all<ParticipantRow>();
  return rows.results ?? [];
}

// ---------------- GET /api/deals ----------------
dealsRoute.get("/", async (c) => {
  const company    = c.req.query("company");        // entity_id or substring of company_name_raw
  const investor   = c.req.query("investor");       // investor entity_id
  const date_from  = c.req.query("date_from");
  const date_to    = c.req.query("date_to");
  const round_name = c.req.query("round_name");
  const event_type = c.req.query("event_type");
  const status     = c.req.query("status");
  const min_amount = c.req.query("min_amount");
  const limit  = clampLimit(c.req.query("limit"));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  const where: string[] = [];
  const binds: unknown[] = [];
  if (company) {
    // Accept either an exact entity_id or a free-text company name substring.
    where.push("(d.company_entity_id = ? OR lower(d.company_name_raw) LIKE ?)");
    binds.push(company, `%${company.toLowerCase()}%`);
  }
  if (investor) {
    where.push("EXISTS (SELECT 1 FROM deal_participants p WHERE p.deal_id = d.id AND p.investor_entity_id = ?)");
    binds.push(investor);
  }
  if (date_from) { where.push("d.announcement_date >= ?"); binds.push(date_from); }
  if (date_to)   { where.push("d.announcement_date <= ?"); binds.push(date_to); }
  if (round_name){ where.push("d.round_name = ?"); binds.push(round_name); }
  if (event_type){ where.push("d.event_type = ?"); binds.push(event_type); }
  if (status)    { where.push("d.status = ?"); binds.push(status); }
  if (min_amount){ where.push("d.amount_usd >= ?"); binds.push(Number(min_amount)); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.event_type, d.company_entity_id, d.company_name_raw, d.round_name,
            d.amount_usd, d.amount_raw, d.valuation_usd, d.valuation_type,
            d.announcement_date, d.closing_date, d.sector_tags_json, d.stage_tags_json,
            d.geography, d.use_of_proceeds, d.source_url, d.source_type,
            d.source_published_at, d.sources_json, d.confidence, d.status
       FROM deal_events d
       ${whereSql}
      ORDER BY d.announcement_date DESC NULLS LAST, d.created_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<DealRow>();
  const dealRows = rows.results ?? [];
  const participants = await loadParticipants(c.env, dealRows.map((r) => r.id));
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM deal_events d ${whereSql}`,
  ).bind(...binds).first<{ n: number }>();
  return c.json({
    total: total?.n ?? 0,
    limit, offset,
    deals: dealRows.map((r) => shape(r, participants)),
  });
});

// ---------------- GET /api/deals/recent ----------------
dealsRoute.get("/recent", async (c) => {
  const days = Math.max(1, Math.min(90, Number(c.req.query("days") ?? 7)));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    `SELECT id, event_type, company_entity_id, company_name_raw, round_name,
            amount_usd, amount_raw, valuation_usd, valuation_type,
            announcement_date, closing_date, sector_tags_json, stage_tags_json,
            geography, use_of_proceeds, source_url, source_type,
            source_published_at, sources_json, confidence, status
       FROM deal_events
      WHERE COALESCE(announcement_date, closing_date) >= ?
      ORDER BY announcement_date DESC NULLS LAST, created_at DESC
      LIMIT 500`,
  ).bind(cutoff).all<DealRow>();
  const dealRows = rows.results ?? [];
  const participants = await loadParticipants(c.env, dealRows.map((r) => r.id));
  // Group by event_type for the weekly-digest shape.
  const byType: Record<string, ReturnType<typeof shape>[]> = {};
  for (const r of dealRows) {
    const k = r.event_type;
    (byType[k] ??= []).push(shape(r, participants));
  }
  const summary = Object.entries(byType).map(([event_type, deals]) => ({
    event_type,
    count: deals.length,
    total_amount_usd: deals.reduce((s, d) => s + (d.amount_usd ?? 0), 0),
    corroborated_count: deals.filter((d) => d.status === "corroborated").length,
    disputed_count: deals.filter((d) => d.status === "disputed").length,
  }));
  return c.json({
    days, cutoff_date: cutoff,
    total: dealRows.length,
    summary,
    by_event_type: byType,
  });
});

// ---------------- GET /api/companies/:id/deal-history ----------------
companiesDealsRoute.get("/:id/deal-history", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT id, event_type, company_entity_id, company_name_raw, round_name,
            amount_usd, amount_raw, valuation_usd, valuation_type,
            announcement_date, closing_date, sector_tags_json, stage_tags_json,
            geography, use_of_proceeds, source_url, source_type,
            source_published_at, sources_json, confidence, status
       FROM deal_events
      WHERE company_entity_id = ?
      ORDER BY COALESCE(announcement_date, closing_date) ASC, created_at ASC
      LIMIT 200`,
  ).bind(id).all<DealRow>();
  const dealRows = rows.results ?? [];
  const participants = await loadParticipants(c.env, dealRows.map((r) => r.id));
  const shaped = dealRows.map((r) => shape(r, participants));
  // Cap-table evolution chart: one point per round, cumulative new
  // investor count.
  const seenInvestors = new Set<string>();
  const cap_table = shaped.map((d) => {
    const newInv: string[] = [];
    for (const p of d.participants) {
      const key = p.investor_entity_id ?? p.investor_name.toLowerCase();
      if (!seenInvestors.has(key)) { seenInvestors.add(key); newInv.push(p.investor_name); }
    }
    return {
      announcement_date: d.announcement_date,
      round_name: d.round_name,
      amount_usd: d.amount_usd,
      post_money_usd: d.valuation_type === "post_money" ? d.valuation_usd : null,
      pre_money_usd: d.valuation_type === "pre_money" ? d.valuation_usd : null,
      new_investors: newInv,
      cumulative_known_investors: seenInvestors.size,
    };
  });
  return c.json({
    company_entity_id: id,
    deal_count: shaped.length,
    total_raised_usd: shaped
      .filter((d) => d.event_type === "funding_round")
      .reduce((s, d) => s + (d.amount_usd ?? 0), 0),
    deals: shaped,
    cap_table_evolution: cap_table,
  });
});

// ---------------- GET /api/investors/:id/deal-history ----------------
investorsDealsRoute.get("/:id/deal-history", async (c) => {
  const id = c.req.param("id");
  const event_type = c.req.query("event_type");
  const date_from  = c.req.query("date_from");
  const role       = c.req.query("role");

  const where: string[] = ["p.investor_entity_id = ?"];
  const binds: unknown[] = [id];
  if (event_type) { where.push("d.event_type = ?"); binds.push(event_type); }
  if (date_from)  { where.push("d.announcement_date >= ?"); binds.push(date_from); }
  if (role)       { where.push("p.role = ?"); binds.push(role); }

  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.event_type, d.company_entity_id, d.company_name_raw, d.round_name,
            d.amount_usd, d.amount_raw, d.valuation_usd, d.valuation_type,
            d.announcement_date, d.closing_date, d.sector_tags_json, d.stage_tags_json,
            d.geography, d.use_of_proceeds, d.source_url, d.source_type,
            d.source_published_at, d.sources_json, d.confidence, d.status,
            p.role AS investor_role, p.position_usd AS investor_position_usd
       FROM deal_participants p
       JOIN deal_events d ON d.id = p.deal_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.announcement_date DESC NULLS LAST, d.created_at DESC
      LIMIT 500`,
  ).bind(...binds).all<DealRow & { investor_role: string; investor_position_usd: number | null }>();
  const dealRows = rows.results ?? [];
  const participants = await loadParticipants(c.env, dealRows.map((r) => r.id));
  return c.json({
    investor_entity_id: id,
    deal_count: dealRows.length,
    led_count: dealRows.filter((r) => r.investor_role === "lead").length,
    total_position_usd: dealRows.reduce((s, r) => s + (r.investor_position_usd ?? 0), 0),
    deals: dealRows.map((r) => ({
      ...shape(r, participants),
      investor_role_in_deal: r.investor_role,
      investor_position_usd: r.investor_position_usd,
    })),
  });
});
