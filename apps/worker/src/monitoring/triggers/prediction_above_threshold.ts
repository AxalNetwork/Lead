import type { EvaluatorFn } from "../types";

// Fires when any prediction for this entity exceeds the rule's threshold
// (default 0.7). Rule config:
//   { min_probability?: number,    // 0..1, default 0.7
//     metric?: string }            // optional filter on prediction.metric
export const evalPredictionAboveThreshold: EvaluatorFn = async (ctx) => {
  const minProb = Number(ctx.ruleConfig.min_probability ?? 0.7);
  const metric  = typeof ctx.ruleConfig.metric === "string" ? ctx.ruleConfig.metric : null;
  const since   = ctx.sinceWatermark;
  try {
    const sinceClause = since ? "AND datetime(generated_at) > datetime(?)" : "";
    const sql = `SELECT id, metric, probability, horizon, generated_at
                   FROM predictions
                  WHERE entity_id = ?
                    AND probability >= ?
                    ${metric ? "AND metric = ?" : ""}
                    ${sinceClause}
                  ORDER BY generated_at DESC LIMIT 5`;
    const binds = [ctx.entityId, minProb,
      ...(metric ? [metric] : []),
      ...(since ? [since] : [])];
    const rows = await ctx.env.DB.prepare(sql).bind(...binds).all<{
      id: string | number; metric: string; probability: number; horizon: string | null; generated_at: string;
    }>();
    const items = rows.results ?? [];
    if (!items.length) return null;
    const top = items[0];
    return {
      dedupe_key: String(top.id ?? `${top.metric}|${Math.round(top.probability * 100)}`),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${top.metric} ${(top.probability * 100).toFixed(0)}%`,
      body: items.slice(0, 3).map((i) => `• ${i.metric}: ${(i.probability * 100).toFixed(0)}%${i.horizon ? ` (${i.horizon})` : ""}`).join("\n"),
      diff: [],
      payload: { items, min_probability: minProb, metric },
    };
  } catch { return null; }
};
