import type { EvaluatorFn } from "../types";

export const evalNewInvestment: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "portfolio_count");
  if (!change) return null;
  const oldN = Number(change.old ?? 0);
  const newN = Number(change.new ?? 0);
  if (newN <= oldN) return null;
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT id, company_entity_id, company_name, announced_at
         FROM investor_investments
        WHERE investor_entity_id = ?
        ORDER BY announced_at DESC LIMIT ?`,
    ).bind(ctx.entityId, newN - oldN).all<{
      id: string | number; company_entity_id: string | null; company_name: string | null; announced_at: string | null;
    }>();
    const items = rows.results ?? [];
    const top = items[0];
    return {
      dedupe_key: String(top?.id ?? `${oldN}->${newN}`),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${newN - oldN} new investment${newN - oldN > 1 ? "s" : ""}`,
      body: items.length
        ? items.slice(0, 3).map((i) => `• ${i.company_name ?? i.company_entity_id} (${i.announced_at ?? "?"})`).join("\n")
        : `Portfolio count ${oldN} → ${newN}.`,
      diff: [change],
      payload: { items, old_count: oldN, new_count: newN },
    };
  } catch {
    return {
      dedupe_key: `${oldN}->${newN}`,
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: portfolio ${oldN} → ${newN}`,
      body: `Portfolio count grew from ${oldN} to ${newN}.`,
      diff: [change],
      payload: { old_count: oldN, new_count: newN },
    };
  }
};
