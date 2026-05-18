// Task #4 saved-alert trigger: "new fund raising in <sector> > $X".
// Source-driven evaluator over the funds table.
//
//   { sectors?: string[], strategies?: string[],
//     min_target_size_usd?: number, fund_status?: string }
//
// "climate-tech > $100M" → sectors=["climate"], min_target_size_usd=1e8,
//                          fund_status="raising"
//
// Watermark = ctx.sinceWatermark on funds.created_at — only new funds
// since the last fire refire.

import type { EvaluatorFn } from "../types";

interface Cfg {
  sectors?: string[];
  strategies?: string[];
  min_target_size_usd?: number;
  fund_status?: string;
}

export const evalNewFundMatch: EvaluatorFn = async (ctx) => {
  const cfg = (ctx.ruleConfig ?? {}) as Cfg;
  const since = ctx.sinceWatermark ?? null;
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (cfg.fund_status) { wheres.push("fund_status = ?"); binds.push(cfg.fund_status); }
  if (Array.isArray(cfg.strategies) && cfg.strategies.length) {
    wheres.push(`strategy IN (${cfg.strategies.map(() => "?").join(",")})`);
    binds.push(...cfg.strategies);
  }
  if (typeof cfg.min_target_size_usd === "number") {
    wheres.push("target_size_usd >= ?"); binds.push(cfg.min_target_size_usd);
  }
  if (Array.isArray(cfg.sectors) && cfg.sectors.length) {
    const ors = cfg.sectors.map(() => "sectors_json LIKE ?").join(" OR ");
    wheres.push(`(${ors})`);
    binds.push(...cfg.sectors.map((s) => `%"${s}"%`));
  }
  if (since) { wheres.push("datetime(created_at) > datetime(?)"); binds.push(since); }
  if (!wheres.length) return null;
  let rows;
  try {
    rows = await ctx.env.DB.prepare(
      `SELECT id, firm_entity_id, fund_name, target_size_usd, strategy, sectors_json, created_at
         FROM funds WHERE ${wheres.join(" AND ")}
         ORDER BY created_at DESC LIMIT 10`,
    ).bind(...binds).all<{
      id: string; firm_entity_id: string; fund_name: string;
      target_size_usd: number | null; strategy: string | null;
      sectors_json: string | null; created_at: string;
    }>();
  } catch { return null; }
  const items = rows.results ?? [];
  if (!items.length) return null;
  const top = items[0];
  return {
    dedupe_key: top.id,
    title: `New fund raising: ${top.fund_name}${top.target_size_usd ? ` ($${(top.target_size_usd / 1e6).toFixed(0)}M target)` : ""}`,
    body: items.slice(0, 5).map((i) =>
      `• ${i.fund_name}${i.target_size_usd ? ` — $${(i.target_size_usd / 1e6).toFixed(0)}M` : ""} (${i.strategy ?? "?"})`,
    ).join("\n"),
    diff: [],
    payload: { items, config: cfg, since },
  };
};
