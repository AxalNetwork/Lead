import type { EvaluatorFn } from "../types";

// For an investor entity, fires when a fresh row appears in
// investor_investments (i.e. a new portfolio company). Defensive: the
// table may not exist in every deployment.
export const evalNewPortfolioAddition: EvaluatorFn = async (ctx) => {
  const since = (ctx.oldSummary as Record<string, unknown> | null)?.["last_investment_at"] as string | null ?? null;
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
      dedupe_key: String(top.id ?? top.company_entity_id ?? top.company_name ?? ""),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: added ${top.company_name ?? top.company_entity_id} to portfolio`,
      body: items.slice(0, 3).map((i) => `• ${i.company_name ?? i.company_entity_id} (${i.announced_at ?? "?"})`).join("\n"),
      diff: [],
      payload: { items, since },
    };
  } catch { return null; }
};
