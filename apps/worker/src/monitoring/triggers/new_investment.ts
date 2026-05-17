import type { EvaluatorFn } from "../types";

export const evalNewInvestment: EvaluatorFn = async (ctx) => {
  // Primary cutoff is the per-entity watermark: investor_investments rows
  // inserted since the last evaluation. Fall back to the summary diff
  // (portfolio_count delta) only when the source table isn't queryable
  // (missing in some deployments) so we still emit on summary-only moves.
  const since = ctx.sinceWatermark;
  const change = ctx.diff.find((d) => d.field === "portfolio_count");
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT id, company_entity_id, company_name, announced_at
         FROM investor_investments
        WHERE investor_entity_id = ?
          ${since ? "AND datetime(announced_at) > datetime(?)" : ""}
        ORDER BY announced_at DESC LIMIT 5`,
    ).bind(...(since ? [ctx.entityId, since] : [ctx.entityId])).all<{
      id: string | number; company_entity_id: string | null; company_name: string | null; announced_at: string | null;
    }>();
    const items = rows.results ?? [];
    if (!items.length) return null;
    const top = items[0];
    return {
      dedupe_key: String(top?.id ?? `since:${since ?? "*"}`),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${items.length} new investment${items.length > 1 ? "s" : ""}`,
      body: items.slice(0, 3).map((i) => `• ${i.company_name ?? i.company_entity_id} (${i.announced_at ?? "?"})`).join("\n"),
      diff: change ? [change] : [],
      payload: { items, since },
    };
  } catch {
    // Source table unavailable — fall back to summary-diff signal.
    if (!change) return null;
    const oldN = Number(change.old ?? 0);
    const newN = Number(change.new ?? 0);
    if (newN <= oldN) return null;
    return {
      dedupe_key: `${oldN}->${newN}`,
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: portfolio ${oldN} → ${newN}`,
      body: `Portfolio count grew from ${oldN} to ${newN}.`,
      diff: [change],
      payload: { old_count: oldN, new_count: newN },
    };
  }
};
