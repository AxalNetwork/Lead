import type { EvaluatorFn } from "../types";

export const evalNewEmployer: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "employer" || d.field === "employer_entity_id");
  if (!change) return null;
  const newEmp = ctx.newSummary.employer ?? null;
  if (!newEmp || newEmp === ctx.oldSummary?.employer) return null;
  return {
    dedupe_key: String(ctx.newSummary.employer_entity_id ?? newEmp),
    title: `${ctx.newSummary.display_name ?? ctx.entityId} joined ${newEmp}`,
    body: `New employer: ${newEmp} (was: ${ctx.oldSummary?.employer ?? "∅"}).`,
    diff: ctx.diff.filter((d) => d.field.startsWith("employer")),
    payload: {
      old_employer: ctx.oldSummary?.employer ?? null,
      new_employer: newEmp,
      new_employer_entity_id: ctx.newSummary.employer_entity_id,
    },
  };
};
