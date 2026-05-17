import type { EvaluatorFn } from "../types";
import { summarizeDiff } from "../diff";

export const evalAnyChange: EvaluatorFn = async (ctx) => {
  if (!ctx.diff.length) return null;
  return {
    dedupe_key: ctx.diff.map((d) => d.field).sort().join(","),
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${ctx.diff.length} field${ctx.diff.length > 1 ? "s" : ""} changed`,
    body: summarizeDiff(ctx.diff),
    diff: ctx.diff,
    payload: { fields: ctx.diff.map((d) => d.field) },
  };
};
