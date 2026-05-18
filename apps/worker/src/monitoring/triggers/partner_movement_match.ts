// Task #4 saved-alert trigger: "any partner leaves <firm>" and
// "any partner promotion at <firm-set>". One evaluator covers both
// shapes via trigger_config:
//
//   { movement_types?: ["left"|"joined"|"promoted"|"title_change"][],
//     firm_entity_ids?: string[],          // matches from_firm OR to_firm
//     from_firm_entity_ids?: string[],     // matches from_firm only
//     to_firm_entity_ids?: string[],       // matches to_firm only
//     status?: "confirmed"|"provisional"|"any" }
//
// "any partner leaves Sequoia"          → movement_types=["left"],
//                                         from_firm_entity_ids=[<sequoia>]
// "partner promotion at warm-intro firms" → movement_types=["promoted"],
//                                         to_firm_entity_ids=[<warm_firms>]
//
// Source-driven evaluator (anchor lives in partner_movements, not the
// entity summary). Watermark = ctx.sinceWatermark — only rows
// observed_at after the watermark are considered, so re-evaluations
// don't refire the same movement.

import type { EvaluatorFn } from "../types";

interface Cfg {
  movement_types?: string[];
  firm_entity_ids?: string[];
  from_firm_entity_ids?: string[];
  to_firm_entity_ids?: string[];
  status?: "confirmed" | "provisional" | "any";
}

export const evalPartnerMovementMatch: EvaluatorFn = async (ctx) => {
  const cfg = (ctx.ruleConfig ?? {}) as Cfg;
  const types = Array.isArray(cfg.movement_types) && cfg.movement_types.length
    ? cfg.movement_types.filter((t) => typeof t === "string") : null;
  const status = cfg.status ?? "confirmed";
  const since = ctx.sinceWatermark ?? null;

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (status !== "any") { wheres.push("status = ?"); binds.push(status); }
  if (types && types.length) {
    wheres.push(`movement_type IN (${types.map(() => "?").join(",")})`);
    binds.push(...types);
  }
  const firmSet = Array.isArray(cfg.firm_entity_ids) ? cfg.firm_entity_ids.filter((s) => typeof s === "string") : [];
  const fromSet = Array.isArray(cfg.from_firm_entity_ids) ? cfg.from_firm_entity_ids.filter((s) => typeof s === "string") : [];
  const toSet = Array.isArray(cfg.to_firm_entity_ids) ? cfg.to_firm_entity_ids.filter((s) => typeof s === "string") : [];
  if (firmSet.length) {
    const ph = firmSet.map(() => "?").join(",");
    wheres.push(`(from_firm_entity_id IN (${ph}) OR to_firm_entity_id IN (${ph}))`);
    binds.push(...firmSet, ...firmSet);
  }
  if (fromSet.length) {
    wheres.push(`from_firm_entity_id IN (${fromSet.map(() => "?").join(",")})`);
    binds.push(...fromSet);
  }
  if (toSet.length) {
    wheres.push(`to_firm_entity_id IN (${toSet.map(() => "?").join(",")})`);
    binds.push(...toSet);
  }
  if (since) { wheres.push("datetime(observed_at) > datetime(?)"); binds.push(since); }
  if (!wheres.length) return null; // safety: a config with no filters would match everything

  let rows;
  try {
    rows = await ctx.env.DB.prepare(
      `SELECT id, person_entity_id, person_name_raw, movement_type,
              from_firm_entity_id, to_firm_entity_id, from_title, to_title,
              observed_at, source_url
         FROM partner_movements WHERE ${wheres.join(" AND ")}
         ORDER BY observed_at DESC LIMIT 10`,
    ).bind(...binds).all<{
      id: string; person_entity_id: string | null; person_name_raw: string;
      movement_type: string; from_firm_entity_id: string | null; to_firm_entity_id: string | null;
      from_title: string | null; to_title: string | null;
      observed_at: string; source_url: string | null;
    }>();
  } catch { return null; }
  const items = rows.results ?? [];
  if (!items.length) return null;
  const top = items[0];
  return {
    dedupe_key: top.id,
    title: `Partner movement: ${top.person_name_raw} — ${top.movement_type}`,
    body: items.slice(0, 5).map((i) =>
      `• ${i.person_name_raw} — ${i.movement_type}${i.to_title ? ` → ${i.to_title}` : ""} (${i.observed_at})`,
    ).join("\n"),
    diff: [],
    payload: { items, config: cfg, since },
  };
};
