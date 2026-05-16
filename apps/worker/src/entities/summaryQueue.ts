// Enqueue + consume `rebuild_summary` work. Uses the existing LEAD_QUEUE
// to avoid provisioning a second queue; the consumer in index.ts
// dispatches by message shape.

import type { Env } from "../types";
import { rebuildSummary } from "./summary";

export interface RebuildSummaryMessage {
  type: "rebuild_summary";
  entityId: string;
}

export function isRebuildSummaryMessage(m: unknown): m is RebuildSummaryMessage {
  return !!m && typeof m === "object" && (m as { type?: unknown }).type === "rebuild_summary"
    && typeof (m as { entityId?: unknown }).entityId === "string";
}

// We intentionally do *not* debounce via KV: the previous design dropped
// later writes when a debounce key was already set, which left
// entity_summary stale until the next mutation. The queue handler can
// coalesce duplicates at consume time if needed; in the meantime, the
// extra work is one upsert into a tiny rollup table.
export async function enqueueSummaryRebuild(env: Env, entityId: string): Promise<void> {
  if (!entityId) return;
  try {
    await env.LEAD_QUEUE.send({ type: "rebuild_summary", entityId } as unknown as never);
  } catch (e) {
    console.warn("enqueueSummaryRebuild failed", entityId, (e as Error).message);
  }
}

export async function handleSummaryMessage(env: Env, m: RebuildSummaryMessage): Promise<void> {
  await rebuildSummary(env, m.entityId);
}
