import type { EvaluatorFn } from "../types";

export const evalDdScoreChange: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "dd_risk_score");
  if (!change) return null;
  const threshold = Number(ctx.ruleConfig.min_delta ?? 5);
  const oldV = Number(change.old ?? 0);
  const newV = Number(change.new ?? 0);
  if (Math.abs(newV - oldV) < threshold) return null;
  return {
    dedupe_key: String(Math.round(newV)),
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: DD risk ${oldV} → ${newV}`,
    body: `Due-diligence risk score moved ${oldV} → ${newV}.`,
    diff: [change],
    payload: { old_score: oldV, new_score: newV, delta: newV - oldV },
  };
};
