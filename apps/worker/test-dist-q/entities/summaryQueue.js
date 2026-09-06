// Enqueue + consume `rebuild_summary` work. Uses the existing LEAD_QUEUE
// to avoid provisioning a second queue; the consumer in index.ts
// dispatches by message shape.
import { rebuildSummary } from "./summary";
export function isRebuildSummaryMessage(m) {
    return !!m && typeof m === "object" && m.type === "rebuild_summary"
        && typeof m.entityId === "string";
}
// We intentionally do *not* debounce via KV: the previous design dropped
// later writes when a debounce key was already set, which left
// entity_summary stale until the next mutation. The queue handler can
// coalesce duplicates at consume time if needed; in the meantime, the
// extra work is one upsert into a tiny rollup table.
export async function enqueueSummaryRebuild(env, entityId) {
    if (!entityId)
        return;
    try {
        await env.LEAD_QUEUE.send({ type: "rebuild_summary", entityId });
    }
    catch (e) {
        console.warn("enqueueSummaryRebuild failed", entityId, e.message);
    }
}
export async function handleSummaryMessage(env, m) {
    await rebuildSummary(env, m.entityId);
}
