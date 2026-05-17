import type { EvaluatorFn } from "../types";

// Triggers when the severity-bucket counts increase. The dedupe key is
// the severity bucket so adding a 2nd "high" finding still fires once
// per (rule, entity, severity) inside the dedupe window.
export const evalDdFindingNew: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "dd_findings_by_severity");
  if (!change) return null;
  const oldB = (change.old ?? { low: 0, medium: 0, high: 0, critical: 0 }) as Record<string, number>;
  const newB = change.new as Record<string, number>;
  const minSev = String(ctx.ruleConfig.min_severity ?? "low").toLowerCase();
  const order = ["low", "medium", "high", "critical"];
  const minIdx = Math.max(0, order.indexOf(minSev));
  const grew: string[] = [];
  for (let i = minIdx; i < order.length; i++) {
    const k = order[i];
    if ((Number(newB[k]) || 0) > (Number(oldB[k]) || 0)) grew.push(k);
  }
  if (!grew.length) return null;
  const top = grew[grew.length - 1];
  return {
    dedupe_key: grew.join(","),
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: new ${top} DD finding`,
    body: `New DD findings — severities: ${grew.join(", ")}.`,
    diff: [change],
    payload: { old_bucket: oldB, new_bucket: newB, grew },
  };
};
