// Task #9: Comp panel engine.
//
// A comp panel pins a screen — sector / business model / ARR band /
// growth band — and refreshes its membership monthly. Members come
// from two pools:
//   - public-company members: filtered from `comp_metrics` (latest
//     quarter per company), carrying full multiples.
//   - private members: filtered from `valuation_marks` joined to
//     facts that match the same screen (sector tag, business model),
//     carrying their latest mark as the inferred valuation.
//
// All writes go through this module (single writer for comp_panels /
// comp_members).

import type { Env } from "../../types";
import type { CompPanelCriteria } from "./types";
import { entityHasSector, SECTOR_MATCHES_COMPANY_ENTITY_SQL } from "../../entities/sector";

export function parseCriteria(raw: string | null): CompPanelCriteria {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (typeof j !== "object" || !j) return {};
    return j as CompPanelCriteria;
  } catch { return {}; }
}

export interface PanelScreenResult {
  public_members: Array<{ company_entity_id: string; company_name: string; ticker: string | null; match_reason: string }>;
  private_members: Array<{ company_entity_id: string; company_name: string; match_reason: string }>;
}

/** Run the panel screen and return matching members. Read-only; the
 *  caller writes results into comp_members. */
export async function screenPanel(
  env: Env, criteria: CompPanelCriteria,
): Promise<PanelScreenResult> {
  // ---- Public members: from comp_metrics + latest row per entity ----
  // Apply revenue/ARR/growth bands. The ticker presence is what
  // distinguishes public from private.
  const pub: PanelScreenResult["public_members"] = [];
  const publicRows = await env.DB.prepare(
    `SELECT cm.company_entity_id, cm.ticker, cm.revenue_usd, cm.arr_usd, cm.growth_yoy_pct,
            e.display_name
       FROM comp_metrics cm
       JOIN u_entities e ON e.id = cm.company_entity_id
      WHERE cm.ticker IS NOT NULL
        AND cm.quarter_end = (
          SELECT MAX(quarter_end) FROM comp_metrics cm2
           WHERE cm2.company_entity_id = cm.company_entity_id
        )
      LIMIT 5000`,
  ).all<{ company_entity_id: string; ticker: string; revenue_usd: number | null; arr_usd: number | null; growth_yoy_pct: number | null; display_name: string }>();
  for (const r of (publicRows.results ?? [])) {
    const reasons: string[] = [];
    if (criteria.revenue_min_usd != null) {
      if (r.revenue_usd == null || r.revenue_usd < criteria.revenue_min_usd) continue;
      reasons.push(`revenue>=${criteria.revenue_min_usd}`);
    }
    if (criteria.revenue_max_usd != null) {
      if (r.revenue_usd == null || r.revenue_usd > criteria.revenue_max_usd) continue;
      reasons.push(`revenue<=${criteria.revenue_max_usd}`);
    }
    if (criteria.arr_min_usd != null) {
      if (r.arr_usd == null || r.arr_usd < criteria.arr_min_usd) continue;
      reasons.push(`arr>=${criteria.arr_min_usd}`);
    }
    if (criteria.arr_max_usd != null) {
      if (r.arr_usd == null || r.arr_usd > criteria.arr_max_usd) continue;
      reasons.push(`arr<=${criteria.arr_max_usd}`);
    }
    if (criteria.growth_min_pct != null) {
      if (r.growth_yoy_pct == null || r.growth_yoy_pct < criteria.growth_min_pct) continue;
      reasons.push(`growth>=${criteria.growth_min_pct}`);
    }
    if (criteria.growth_max_pct != null) {
      if (r.growth_yoy_pct == null || r.growth_yoy_pct > criteria.growth_max_pct) continue;
      reasons.push(`growth<=${criteria.growth_max_pct}`);
    }
    // Sector / business_model: match against facts on the entity.
    if (criteria.sector) {
      // A miss here `continue`s past the candidate, so reading the three
      // singular predicates nothing writes did not return an unfiltered
      // panel — it returned an EMPTY one, and an operator filtering by
      // sector concluded there were no comparable companies.
      if (!(await entityHasSector(env, r.company_entity_id, criteria.sector))) continue;
      reasons.push(`sector=${criteria.sector}`);
    }
    if (criteria.business_model) {
      // Left as-is deliberately: `company.business_model` also has no writer,
      // but unlike sector there is no alternative spelling anywhere in the
      // schema to converge on. Widening it would be inventing a source. The
      // criterion is operator-set, so it only bites when explicitly asked for.
      const f = await env.DB.prepare(
        `SELECT 1 FROM facts WHERE entity_id = ? AND predicate IN ('company.business_model','business_model')
            AND lower(value_text) = lower(?) AND is_current = 1 LIMIT 1`,
      ).bind(r.company_entity_id, criteria.business_model).first();
      if (!f) continue;
      reasons.push(`model=${criteria.business_model}`);
    }
    pub.push({
      company_entity_id: r.company_entity_id, company_name: r.display_name,
      ticker: r.ticker, match_reason: reasons.join(",") || "unconstrained",
    });
  }
  // ---- Private members: companies with a valuation_mark but no ticker ----
  // Match by sector facts only. Financial bands (revenue/ARR/growth)
  // are PUBLIC-ONLY screen dimensions for now: private companies
  // rarely disclose ARR/growth uniformly, so applying those filters
  // would silently drop most candidates. This is by design; the panel
  // documents membership in `match_reason`. Without a sector criterion
  // we skip private discovery entirely (avoids runaway result sets).
  const priv: PanelScreenResult["private_members"] = [];
  if (criteria.sector) {
    const privRows = await env.DB.prepare(
      `SELECT DISTINCT vm.company_entity_id, e.display_name
         FROM valuation_marks vm
         JOIN u_entities e ON e.id = vm.company_entity_id
        WHERE ${SECTOR_MATCHES_COMPANY_ENTITY_SQL}
          AND vm.company_entity_id NOT IN (SELECT company_entity_id FROM comp_metrics WHERE ticker IS NOT NULL)
        LIMIT 500`,
    ).bind(criteria.sector, criteria.sector, criteria.sector)
      .all<{ company_entity_id: string; display_name: string }>();
    for (const r of (privRows.results ?? [])) {
      priv.push({
        company_entity_id: r.company_entity_id, company_name: r.display_name,
        match_reason: `sector=${criteria.sector}`,
      });
    }
  }
  return { public_members: pub, private_members: priv };
}

export async function createCompPanel(
  env: Env, name: string, description: string | null,
  criteria: CompPanelCriteria, createdBy: string | null,
): Promise<{ panel_id: string }> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO comp_panels (id, name, description, criteria_json, created_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, name, description ?? null, JSON.stringify(criteria), createdBy ?? null).run();
  return { panel_id: id };
}

export async function refreshPanelMembership(env: Env, panelId: string): Promise<{ public_count: number; private_count: number }> {
  const panel = await env.DB.prepare(
    `SELECT criteria_json FROM comp_panels WHERE id = ?`,
  ).bind(panelId).first<{ criteria_json: string }>();
  if (!panel) return { public_count: 0, private_count: 0 };
  const criteria = parseCriteria(panel.criteria_json);
  const result = await screenPanel(env, criteria);
  // Soft-delete current membership (mark removed_at), then upsert.
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE comp_members SET removed_at = ? WHERE panel_id = ? AND removed_at IS NULL`,
  ).bind(now, panelId).run();
  for (const m of result.public_members) {
    await env.DB.prepare(
      `INSERT INTO comp_members (id, panel_id, company_entity_id, company_name_raw, is_public, ticker, match_reason)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(panel_id, company_entity_id) DO UPDATE SET
         removed_at = NULL, is_public = 1, ticker = excluded.ticker, match_reason = excluded.match_reason`,
    ).bind(crypto.randomUUID(), panelId, m.company_entity_id, m.company_name, m.ticker, m.match_reason).run();
  }
  for (const m of result.private_members) {
    await env.DB.prepare(
      `INSERT INTO comp_members (id, panel_id, company_entity_id, company_name_raw, is_public, ticker, match_reason)
       VALUES (?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(panel_id, company_entity_id) DO UPDATE SET
         removed_at = NULL, is_public = 0, match_reason = excluded.match_reason`,
    ).bind(crypto.randomUUID(), panelId, m.company_entity_id, m.company_name, m.match_reason).run();
  }
  const total = result.public_members.length + result.private_members.length;
  await env.DB.prepare(
    `UPDATE comp_panels SET last_refreshed_at = ?, member_count = ? WHERE id = ?`,
  ).bind(now, total, panelId).run();
  return { public_count: result.public_members.length, private_count: result.private_members.length };
}

/** Refresh all comp panels older than `staleHours`. Called from the
 *  nightly cron tick. */
export async function refreshStaleCompPanels(env: Env, staleHours = 24 * 28): Promise<{ refreshed: number }> {
  const cutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();
  const r = await env.DB.prepare(
    `SELECT id FROM comp_panels
      WHERE last_refreshed_at IS NULL OR last_refreshed_at < ?
      ORDER BY last_refreshed_at NULLS FIRST
      LIMIT 50`,
  ).bind(cutoff).all<{ id: string }>();
  let n = 0;
  for (const row of (r.results ?? [])) {
    try { await refreshPanelMembership(env, row.id); n += 1; }
    catch (e) { console.warn("refreshPanelMembership failed", row.id, (e as Error).message); }
  }
  return { refreshed: n };
}
