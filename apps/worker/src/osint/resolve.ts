// Resolve engine — orchestrates pivots → scoring → guardrails → auto-link
// vs review-queue → write-back. Wrapped in EntityLock to serialize against
// concurrent merges + other resolvers for the same entity.

import type { Env } from "../types";
import type { ResolveSummary } from "./types";
import { loadKnownFacts } from "./facts";
import { runAllPivots, type OrchestratorOptions } from "./pivots/index";
import { scoreHits, isBlocklisted, isCommonNameOnly, isCrossLinkedToDifferentEntity, isAutoLinkEligible } from "./guardrails";

export { isAutoLinkEligible } from "./guardrails";

export interface ResolveOptions extends OrchestratorOptions {
  // Force-route a candidate to the review queue regardless of confidence.
  manualReviewOnly?: boolean;
}

export async function resolveEntity(env: Env, entityId: string, opts: ResolveOptions = {}): Promise<ResolveSummary> {
  const tStart = Date.now();
  const facts = await loadKnownFacts(env, entityId);

  // Serialize this resolver run against other writers on the same entity.
  // Acquire EntityLock if available (production); no-op fallback otherwise.
  const release = await acquireEntityLock(env, entityId);
  try {
    const pivots = await runAllPivots(env, facts, opts);
    const allHits = pivots.flatMap((p) => p.hits);
    const scored = scoreHits(allHits);

    let autoLinked = 0;
    let candidatesAdded = 0;
    let conflictsSurfaced = 0;

    const isCommon = isCommonNameOnly(facts.displayName);

    for (const h of scored) {
      // Never overwrite an already-known active handle.
      if (facts.knownHandles.some((kh) => kh.platform === h.platform && kh.handle.toLowerCase() === h.handle.toLowerCase())) continue;

      const guard = isBlocklisted(h.platform, h.handle);
      if (guard.blocked) {
        await insertCandidate(env, entityId, h, "guardrail:" + guard.reason);
        candidatesAdded++;
        continue;
      }

      const conflict = await isCrossLinkedToDifferentEntity(env, h.platform, h.handle, entityId);
      if (conflict) {
        await insertCandidate(env, entityId, h, "conflict:cross_linked");
        conflictsSurfaced++;
        candidatesAdded++;
        continue;
      }

      const decision = opts.manualReviewOnly
        ? { eligible: false as const, reason: "manual_review_only" }
        : isAutoLinkEligible({
            linkMethod: h.link_method,
            finalConfidence: h.final_confidence,
            corroborations: h.corroborations,
            isCommonName: isCommon,
          });

      if (decision.eligible) {
        await upsertActiveHandle(env, entityId, h);
        autoLinked++;
      } else {
        await insertCandidate(env, entityId, h, decision.reason);
        candidatesAdded++;
      }
    }

    await persistRunLog(env, entityId, pivots);

    return {
      entityId,
      pivots,
      autoLinked,
      candidatesAdded,
      conflictsSurfaced,
      totalMs: Date.now() - tStart,
    };
  } finally {
    await release().catch(() => undefined);
  }
}

// Exported so route handlers that mutate identity_handles (e.g. operator
// accept on a candidate) go through the same single write path. Returns a
// release() — caller must invoke it in a finally block.
export async function acquireEntityLock(env: Env, entityId: string): Promise<() => Promise<void>> {
  if (!env.ENTITY_LOCK) return async () => undefined;
  try {
    const id = env.ENTITY_LOCK.idFromName(entityId);
    const stub = env.ENTITY_LOCK.get(id);
    const token = crypto.randomUUID();
    const res = await stub.fetch("https://lock/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ttlMs: 60_000 }),
    });
    if (!res.ok) return async () => undefined;
    return async () => {
      try {
        await stub.fetch("https://lock/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch { /* ignore */ }
    };
  } catch { return async () => undefined; }
}

// True when the error message indicates the partial unique index on
// (platform, handle) WHERE is_active=1 blocked the attach because the
// same external handle is already active on a DIFFERENT entity.
function isCrossEntityUniqueViolation(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  return /UNIQUE constraint failed/i.test(m) && /idx_ih_active_global_ph|identity_handles\.platform/i.test(m);
}

export async function attachHandleOrQueueMerge(
  env: Env,
  entityId: string,
  h: { platform: string; handle: string; url?: string; link_method: string; final_confidence: number; evidence_json: Record<string, unknown>; corroborations: number },
): Promise<{ attached: boolean; queuedMergeReview: boolean }> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO identity_handles (id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json, is_active, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(entity_id, platform, handle) DO UPDATE SET
         url = COALESCE(excluded.url, identity_handles.url),
         link_method = excluded.link_method,
         link_confidence = max(identity_handles.link_confidence, excluded.link_confidence),
         evidence_json = excluded.evidence_json,
         is_active = 1,
         last_verified_at = datetime('now'),
         updated_at = datetime('now')`,
    ).bind(
      id, entityId, h.platform, h.handle.toLowerCase(), h.url ?? null, h.link_method,
      h.final_confidence, JSON.stringify({ ...h.evidence_json, corroborations: h.corroborations }),
    ).run();
    return { attached: true, queuedMergeReview: false };
  } catch (e) {
    if (!isCrossEntityUniqueViolation(e)) throw e;
    // Surface the conflict as a merge-review candidate so an operator
    // can decide whether the two entities should be merged, or one of
    // the links is wrong.
    const owner = await env.DB.prepare(
      `SELECT entity_id FROM identity_handles
         WHERE platform = ? AND handle = ? AND is_active = 1 LIMIT 1`,
    ).bind(h.platform, h.handle.toLowerCase()).first<{ entity_id: string }>();
    await env.DB.prepare(
      `INSERT INTO handle_candidates (id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(platform, handle, entity_id) DO UPDATE SET
         link_method = 'merge_review',
         evidence_json = excluded.evidence_json,
         updated_at = datetime('now')`,
    ).bind(
      crypto.randomUUID(), entityId, h.platform, h.handle.toLowerCase(), h.url ?? null,
      "merge_review", h.final_confidence,
      JSON.stringify({ ...h.evidence_json, queue_reason: "cross_entity_handle_conflict", conflicting_entity_id: owner?.entity_id ?? null, corroborations: h.corroborations }),
    ).run();
    return { attached: false, queuedMergeReview: true };
  }
}

async function upsertActiveHandle(env: Env, entityId: string, h: { platform: string; handle: string; url?: string; link_method: string; final_confidence: number; evidence_json: Record<string, unknown>; corroborations: number }): Promise<void> {
  await attachHandleOrQueueMerge(env, entityId, h);
}

async function insertCandidate(env: Env, entityId: string, h: { platform: string; handle: string; url?: string; link_method: string; final_confidence: number; evidence_json: Record<string, unknown>; corroborations: number }, reason: string): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO handle_candidates (id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(platform, handle, entity_id) DO UPDATE SET
       link_confidence = max(handle_candidates.link_confidence, excluded.link_confidence),
       evidence_json = excluded.evidence_json,
       updated_at = datetime('now')`,
  ).bind(
    id, entityId, h.platform, h.handle.toLowerCase(), h.url ?? null, h.link_method, h.final_confidence,
    JSON.stringify({ ...h.evidence_json, queue_reason: reason, corroborations: h.corroborations }),
  ).run();
}

async function persistRunLog(env: Env, entityId: string, pivots: ResolveSummary["pivots"]): Promise<void> {
  try {
    const summary = pivots.map((p) => ({ pivot: p.pivot, hits: p.hits.length, ms: p.durationMs, error: p.error ?? null }));
    await env.DB.prepare(
      `INSERT INTO osint_entity_state (entity_id, last_osint_run_at, pivots_log_json, updated_at)
       VALUES (?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(entity_id) DO UPDATE SET
         last_osint_run_at = excluded.last_osint_run_at,
         pivots_log_json = excluded.pivots_log_json,
         updated_at = datetime('now')`,
    ).bind(entityId, JSON.stringify(summary)).run();
  } catch (e) {
    console.warn("osint_entity_state write failed", (e as Error).message);
  }
}
