import type { EvaluatorFn } from "../types";

// For org-kind entities, surface employer/role changes among their
// affiliated people. Falls back to title/role diff on the entity itself.
export const evalExecutiveChange: EvaluatorFn = async (ctx) => {
  const roleD = ctx.diff.find((d) => d.field === "role");
  const titleD = ctx.diff.find((d) => d.field === "title");
  if (!roleD && !titleD) return null;
  return {
    dedupe_key: `${ctx.newSummary.title ?? ""}|${ctx.newSummary.role ?? ""}`,
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: executive change`,
    body: [roleD, titleD].filter(Boolean)
      .map((d) => `${d!.field}: ${d!.old ?? "∅"} → ${d!.new ?? "∅"}`).join("; "),
    diff: [roleD, titleD].filter((d): d is NonNullable<typeof d> => !!d),
    payload: {
      new_role: ctx.newSummary.role, new_title: ctx.newSummary.title,
      old_role: ctx.oldSummary?.role, old_title: ctx.oldSummary?.title,
    },
  };
};
