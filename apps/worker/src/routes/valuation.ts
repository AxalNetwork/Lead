// Task #9: Valuation Intelligence routes.
//
//   GET  /api/companies/:id/marks                — all marks for a company
//   GET  /api/companies/:id/implied-valuation    — comp-panel-derived range
//   GET  /api/comp-panels                         — list panels
//   GET  /api/comp-panels/:id/snapshot           — panel members + multiples
//   POST /api/comp-panels                         — admin: build a new panel
//
// All routes mount under /api/* behind accessGuard. POST is admin-only.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  computeImpliedValuation, createCompPanel, refreshPanelMembership,
  SOURCE_CONFIDENCE,
} from "../services/valuation";
import type { CompPanelCriteria } from "../services/valuation";

type Vars = { email: string; is_admin: boolean };

export const valuationCompaniesRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const compPanelsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

async function resolveEntityIdFromCompanyParam(
  env: Env, idParam: string,
): Promise<string | null> {
  if (/^[0-9]+$/.test(idParam)) {
    const c = await env.DB.prepare(
      `SELECT name FROM companies WHERE id = ?`,
    ).bind(Number(idParam)).first<{ name: string }>();
    if (!c) return null;
    const { normalizeCompanyName } = await import("../services/deals/dedupe");
    const norm = normalizeCompanyName(c.name);
    if (!norm) return null;
    const r = await env.DB.prepare(
      `SELECT entity_id FROM facts WHERE predicate='company.name_normalized' AND value_text=? AND is_current=1 LIMIT 1`,
    ).bind(norm).first<{ entity_id: string }>();
    return r?.entity_id ?? null;
  }
  return idParam;
}

interface MarkRow {
  id: string; company_entity_id: string; company_name_raw: string;
  as_of: string; source_kind: string; source_url: string | null;
  source_ref: string | null; implied_valuation_usd: number | null;
  share_price_usd: number | null; fully_diluted_shares: number | null;
  mark_kind: string | null; confidence: number;
  holder_name_raw: string | null; notes: string | null;
}

// ============================================================ GET /:id/marks
valuationCompaniesRoute.get("/:id/marks", async (c) => {
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT id, company_entity_id, company_name_raw, as_of, source_kind,
            source_url, source_ref, implied_valuation_usd, share_price_usd,
            fully_diluted_shares, mark_kind, confidence, holder_name_raw, notes
       FROM valuation_marks
      WHERE company_entity_id = ?
      ORDER BY as_of ASC, confidence DESC`,
  ).bind(entityId).all<MarkRow>();
  const marks = (rows.results ?? []).map((r) => ({
    mark_id: r.id, as_of: r.as_of, source_kind: r.source_kind,
    source_url: r.source_url, source_ref: r.source_ref,
    implied_valuation_usd: r.implied_valuation_usd,
    share_price_usd: r.share_price_usd,
    fully_diluted_shares: r.fully_diluted_shares,
    mark_kind: r.mark_kind, confidence: r.confidence,
    holder_name_raw: r.holder_name_raw, notes: r.notes,
  }));
  // Confidence-weighted blended line: monthly buckets, weighted by
  // each mark's confidence within the bucket.
  const buckets = new Map<string, { sum: number; weight: number }>();
  for (const m of marks) {
    if (m.implied_valuation_usd == null) continue;
    const bucket = m.as_of.slice(0, 7);
    const w = m.confidence;
    const b = buckets.get(bucket) ?? { sum: 0, weight: 0 };
    b.sum += m.implied_valuation_usd * w;
    b.weight += w;
    buckets.set(bucket, b);
  }
  const blended = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, b]) => ({ month, blended_valuation_usd: Math.round(b.sum / b.weight) }));
  return c.json({
    entity_id: entityId, count: marks.length,
    source_confidence: SOURCE_CONFIDENCE,
    marks, blended_line: blended,
  });
});

// ============================================================ GET /:id/implied-valuation
valuationCompaniesRoute.get("/:id/implied-valuation", async (c) => {
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const r = await computeImpliedValuation(c.env, entityId);
  return c.json({ entity_id: entityId, ...r });
});

// ============================================================ GET /comp-panels
compPanelsRoute.get("/", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, name, description, criteria_json, last_refreshed_at, member_count, created_at
       FROM comp_panels ORDER BY last_refreshed_at DESC NULLS LAST LIMIT 200`,
  ).all<{ id: string; name: string; description: string | null; criteria_json: string; last_refreshed_at: string | null; member_count: number; created_at: string }>();
  return c.json({
    count: (r.results ?? []).length,
    panels: (r.results ?? []).map((p) => ({
      panel_id: p.id, name: p.name, description: p.description,
      criteria: (() => { try { return JSON.parse(p.criteria_json); } catch { return {}; } })(),
      last_refreshed_at: p.last_refreshed_at, member_count: p.member_count,
      created_at: p.created_at,
    })),
  });
});

// ============================================================ GET /comp-panels/:id/snapshot
compPanelsRoute.get("/:id/snapshot", async (c) => {
  const panelId = c.req.param("id");
  const panel = await c.env.DB.prepare(
    `SELECT id, name, description, criteria_json, last_refreshed_at, member_count
       FROM comp_panels WHERE id = ?`,
  ).bind(panelId).first<{ id: string; name: string; description: string | null; criteria_json: string; last_refreshed_at: string | null; member_count: number }>();
  if (!panel) return c.json({ error: "panel_not_found" }, 404);
  const members = await c.env.DB.prepare(
    `SELECT m.company_entity_id, m.company_name_raw, m.is_public, m.ticker, m.match_reason,
            cm.revenue_usd, cm.arr_usd, cm.growth_yoy_pct, cm.gross_margin_pct,
            cm.rule_of_40_pct, cm.ev_revenue_multiple, cm.ev_arr_multiple,
            cm.enterprise_value_usd, cm.quarter_end
       FROM comp_members m
       LEFT JOIN comp_metrics cm ON cm.company_entity_id = m.company_entity_id
          AND cm.quarter_end = (
            SELECT MAX(quarter_end) FROM comp_metrics cm2
             WHERE cm2.company_entity_id = m.company_entity_id
          )
      WHERE m.panel_id = ? AND m.removed_at IS NULL
      ORDER BY m.is_public DESC, cm.ev_arr_multiple DESC NULLS LAST`,
  ).bind(panelId).all<{
    company_entity_id: string; company_name_raw: string; is_public: number;
    ticker: string | null; match_reason: string;
    revenue_usd: number | null; arr_usd: number | null;
    growth_yoy_pct: number | null; gross_margin_pct: number | null;
    rule_of_40_pct: number | null; ev_revenue_multiple: number | null;
    ev_arr_multiple: number | null; enterprise_value_usd: number | null;
    quarter_end: string | null;
  }>();
  // For private members, attach latest mark.
  const out = await Promise.all((members.results ?? []).map(async (m) => {
    const base = {
      company_entity_id: m.company_entity_id, company_name: m.company_name_raw,
      is_public: !!m.is_public, ticker: m.ticker, match_reason: m.match_reason,
    };
    if (m.is_public) {
      return { ...base,
        revenue_usd: m.revenue_usd, arr_usd: m.arr_usd,
        growth_yoy_pct: m.growth_yoy_pct, gross_margin_pct: m.gross_margin_pct,
        rule_of_40_pct: m.rule_of_40_pct,
        ev_revenue_multiple: m.ev_revenue_multiple,
        ev_arr_multiple: m.ev_arr_multiple,
        enterprise_value_usd: m.enterprise_value_usd,
        quarter_end: m.quarter_end,
        inferred_valuation_low_usd: null, inferred_valuation_high_usd: null,
      };
    }
    const mark = await c.env.DB.prepare(
      `SELECT implied_valuation_usd, as_of, source_kind, confidence
         FROM valuation_marks WHERE company_entity_id = ?
        ORDER BY as_of DESC, confidence DESC LIMIT 1`,
    ).bind(m.company_entity_id).first<{ implied_valuation_usd: number | null; as_of: string; source_kind: string; confidence: number }>();
    const v = mark?.implied_valuation_usd ?? null;
    return { ...base,
      revenue_usd: null, arr_usd: null,
      growth_yoy_pct: null, gross_margin_pct: null, rule_of_40_pct: null,
      ev_revenue_multiple: null, ev_arr_multiple: null,
      enterprise_value_usd: null, quarter_end: null,
      latest_mark: mark ?? null,
      inferred_valuation_low_usd: v != null ? Math.round(v * 0.7) : null,
      inferred_valuation_high_usd: v != null ? Math.round(v * 1.3) : null,
    };
  }));
  // Compute panel medians from public members.
  const evArr: number[] = [], evRev: number[] = [];
  for (const m of out) {
    if (m.ev_arr_multiple != null && m.ev_arr_multiple > 0) evArr.push(m.ev_arr_multiple);
    if (m.ev_revenue_multiple != null && m.ev_revenue_multiple > 0) evRev.push(m.ev_revenue_multiple);
  }
  const med = (arr: number[]) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;
  return c.json({
    panel_id: panel.id, name: panel.name, description: panel.description,
    criteria: (() => { try { return JSON.parse(panel.criteria_json); } catch { return {}; } })(),
    last_refreshed_at: panel.last_refreshed_at,
    member_count: panel.member_count,
    medians: { ev_arr: med(evArr), ev_revenue: med(evRev) },
    members: out,
  });
});

// ============================================================ POST /comp-panels (admin)
compPanelsRoute.post("/", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof (body as { name?: unknown }).name === "string" ? ((body as { name: string }).name).trim() : "";
  if (!name) return c.json({ error: "name_required" }, 400);
  const description = typeof (body as { description?: unknown }).description === "string"
    ? (body as { description: string }).description : null;
  const criteria = ((body as { criteria?: unknown }).criteria ?? {}) as CompPanelCriteria;
  if (!criteria || typeof criteria !== "object") return c.json({ error: "criteria_required" }, 400);
  let panel_id: string;
  try {
    const r = await createCompPanel(c.env, name, description, criteria, c.var.email);
    panel_id = r.panel_id;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) return c.json({ error: "name_conflict" }, 409);
    throw e;
  }
  const refresh = await refreshPanelMembership(c.env, panel_id);
  return c.json({ panel_id, name, criteria, ...refresh });
});
