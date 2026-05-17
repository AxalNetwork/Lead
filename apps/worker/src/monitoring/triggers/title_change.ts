import type { EvaluatorFn } from "../types";

export const evalTitleChange: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "title");
  if (!change) return null;
  const newTitle = (change.new ?? "") as string;
  return {
    dedupe_key: String(newTitle ?? ""),
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: title changed to ${newTitle || "∅"}`,
    body: `Title changed from "${change.old ?? "∅"}" to "${newTitle || "∅"}".`,
    diff: [change],
    payload: { old_title: change.old, new_title: change.new },
  };
};
