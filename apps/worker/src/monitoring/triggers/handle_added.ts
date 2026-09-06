import type { EvaluatorFn } from "../types";

export const evalHandleAdded: EvaluatorFn = async (ctx) => {
  const change = ctx.diff.find((d) => d.field === "handles_count");
  if (!change) return null;
  const oldN = Number(change.old ?? 0);
  const newN = Number(change.new ?? 0);
  if (newN <= oldN) return null;
  let added: Array<{ platform: string; handle: string }> = [];
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT platform, handle FROM identity_handles WHERE entity_id = ?
         ORDER BY created_at DESC LIMIT ?`,
    ).bind(ctx.entityId, newN - oldN).all<{ platform: string; handle: string }>();
    added = rows.results ?? [];
  } catch { /* ignore */ }
  return {
    dedupe_key: added.map((a) => `${a.platform}:${a.handle}`).sort().join(",") || `${oldN}->${newN}`,
    title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${newN - oldN} new handle${newN - oldN > 1 ? "s" : ""}`,
    body: added.length
      ? added.map((a) => `• ${a.platform}: ${a.handle}`).join("\n")
      : `Handles ${oldN} → ${newN}.`,
    diff: [change],
    payload: { added, old_count: oldN, new_count: newN },
  };
};
