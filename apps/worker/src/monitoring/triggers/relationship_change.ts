import type { EvaluatorFn } from "../types";

// Fires when this entity is on either side of a fresh row in the
// relationships table (e.g. board appointment, co-investment, advisor).
export const evalRelationshipChange: EvaluatorFn = async (ctx) => {
  const since = (ctx.oldSummary as Record<string, unknown> | null)?.["last_relationship_at"] as string | null ?? null;
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT id, source_entity_id, target_entity_id, kind, created_at
         FROM relationships
        WHERE (source_entity_id = ? OR target_entity_id = ?)
          ${since ? "AND datetime(created_at) > datetime(?)" : ""}
        ORDER BY created_at DESC LIMIT 5`,
    ).bind(...(since ? [ctx.entityId, ctx.entityId, since] : [ctx.entityId, ctx.entityId])).all<{
      id: string | number; source_entity_id: string; target_entity_id: string; kind: string; created_at: string;
    }>();
    const items = rows.results ?? [];
    if (!items.length) return null;
    const top = items[0];
    const other = top.source_entity_id === ctx.entityId ? top.target_entity_id : top.source_entity_id;
    return {
      dedupe_key: String(top.id ?? `${top.kind}|${other}`),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${items.length} new relationship${items.length > 1 ? "s" : ""}`,
      body: items.slice(0, 3).map((i) => {
        const o = i.source_entity_id === ctx.entityId ? i.target_entity_id : i.source_entity_id;
        return `• ${i.kind} ↔ ${o} (${i.created_at})`;
      }).join("\n"),
      diff: [],
      payload: { items, since },
    };
  } catch { return null; }
};
