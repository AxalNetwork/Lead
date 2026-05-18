// Task #4 saved-alert trigger: "LBO > $500M in my target sectors".
// Source-driven evaluator over deal_events (the platform-global deal
// ledger holds PE + VC deals under one schema; deal_type/event_type
// distinguishes them — buyouts surface as event_type='acquisition'
// with sector_tags tagging the strategy).
//
// Spec language references a `pe_deals` table; in this codebase
// buyout activity is recorded in `deal_events` (event_type IN
// ('acquisition','merger','recapitalization')) per migration 351.
// We match on that to keep the alert engine source-true.
//
//   { event_types?: string[], min_amount_usd?: number, sectors?: string[] }

import type { EvaluatorFn } from "../types";

interface Cfg {
  event_types?: string[];
  min_amount_usd?: number;
  sectors?: string[];
}

export const evalPeDealMatch: EvaluatorFn = async (ctx) => {
  const cfg = (ctx.ruleConfig ?? {}) as Cfg;
  const since = ctx.sinceWatermark ?? null;
  const types = Array.isArray(cfg.event_types) && cfg.event_types.length
    ? cfg.event_types : ["acquisition", "merger", "recapitalization"];
  const wheres: string[] = [
    `event_type IN (${types.map(() => "?").join(",")})`,
  ];
  const binds: unknown[] = [...types];
  if (typeof cfg.min_amount_usd === "number") {
    wheres.push("amount_usd >= ?"); binds.push(cfg.min_amount_usd);
  }
  if (Array.isArray(cfg.sectors) && cfg.sectors.length) {
    const ors = cfg.sectors.map(() => "sector_tags_json LIKE ?").join(" OR ");
    wheres.push(`(${ors})`);
    binds.push(...cfg.sectors.map((s) => `%"${s}"%`));
  }
  if (since) { wheres.push("datetime(announcement_date) > datetime(?)"); binds.push(since); }
  let rows;
  try {
    rows = await ctx.env.DB.prepare(
      `SELECT id, event_type, company_name_raw, amount_usd, announcement_date,
              sector_tags_json, source_url
         FROM deal_events WHERE ${wheres.join(" AND ")}
         ORDER BY announcement_date DESC LIMIT 10`,
    ).bind(...binds).all<{
      id: string; event_type: string; company_name_raw: string;
      amount_usd: number | null; announcement_date: string | null;
      sector_tags_json: string | null; source_url: string | null;
    }>();
  } catch { return null; }
  const items = rows.results ?? [];
  if (!items.length) return null;
  const top = items[0];
  return {
    dedupe_key: top.id,
    title: `${top.event_type}: ${top.company_name_raw}${top.amount_usd ? ` ($${(top.amount_usd / 1e6).toFixed(0)}M)` : ""}`,
    body: items.slice(0, 5).map((i) =>
      `• ${i.event_type} — ${i.company_name_raw}${i.amount_usd ? ` $${(i.amount_usd / 1e6).toFixed(0)}M` : ""} (${i.announcement_date ?? "?"})`,
    ).join("\n"),
    diff: [],
    payload: { items, config: cfg, since },
  };
};
