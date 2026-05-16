// First-class entity merge. Picks a primary by quality_score → fact count
// → created_at, moves every fact/channel/tag/edge, sets the secondary to
// status='merged' with merged_into_entity_id pointing at the primary, and
// writes a complete entity_history audit trail. Re-embedding to Vectorize
// + AI Search is best-effort and non-blocking.

import type { Env } from "../types";
import { enqueueSummaryRebuild } from "./summaryQueue";

export interface MergeResult {
  primary_id: string;
  secondary_id: string;
  facts_moved: number;
  channels_moved: number;
  tags_moved: number;
  edges_rewritten: number;
}

async function pickPrimary(env: Env, aId: string, bId: string): Promise<{ primary: string; secondary: string }> {
  const rows = await env.DB.prepare(
    `SELECT e.id, e.quality_score, e.created_at,
            (SELECT COUNT(*) FROM facts f WHERE f.entity_id = e.id AND f.is_current = 1) AS fact_count
     FROM u_entities e WHERE e.id IN (?, ?)`,
  ).bind(aId, bId).all<{ id: string; quality_score: number; created_at: string; fact_count: number }>();
  const list = rows.results ?? [];
  if (list.length < 2) throw new Error(`merge: missing entity (${aId}, ${bId})`);
  list.sort((x, y) => {
    if (y.quality_score !== x.quality_score) return y.quality_score - x.quality_score;
    if (y.fact_count !== x.fact_count) return y.fact_count - x.fact_count;
    return Date.parse(x.created_at) - Date.parse(y.created_at); // older wins
  });
  return { primary: list[0].id, secondary: list[1].id };
}

async function mergeCore(env: Env, primary: string, secondary: string): Promise<MergeResult> {
  // Pre-merge dedup: bring secondary rows into compliance with the
  // primary's UNIQUE constraints *before* the batch runs, so the
  // UPDATEs that re-point entity_id don't abort. This covers facts
  // (partial-unique on current-row per (entity,predicate,source) from
  // migration 209), channels, tags, and rel_edges (both src-collision
  // and dst-collision against the primary).

  // Facts: if both entities have an is_current=1 fact for the same
  // (predicate, source), the secondary's current row would collide
  // with the primary's after the entity_id rewrite. Flip those
  // secondary rows to is_current=0 so history is preserved but the
  // partial UNIQUE index (uq_facts_current_per_pred) holds. We rely
  // on IFNULL(source,'') for the comparison to match the index's
  // own key expression.
  await env.DB.prepare(
    `UPDATE facts
        SET is_current = 0
      WHERE entity_id = ?
        AND is_current = 1
        AND EXISTS (
          SELECT 1 FROM facts p
           WHERE p.entity_id = ?
             AND p.is_current = 1
             AND p.predicate = facts.predicate
             AND IFNULL(p.source,'') = IFNULL(facts.source,'')
        )`,
  ).bind(secondary, primary).run();
  await env.DB.prepare(
    `DELETE FROM channels WHERE entity_id = ? AND (kind, canonical) IN
       (SELECT kind, canonical FROM channels WHERE entity_id = ?)`,
  ).bind(secondary, primary).run();
  await env.DB.prepare(
    `DELETE FROM entity_tags WHERE entity_id = ? AND (taxonomy, slug) IN
       (SELECT taxonomy, slug FROM entity_tags WHERE entity_id = ?)`,
  ).bind(secondary, primary).run();
  // rel_edges: a secondary edge that would collide with an existing
  // primary edge on the same (dst, kind, valid_from) (when secondary is
  // src) or (src, kind, valid_from) (when secondary is dst) is deleted.
  // Same-entity self-loops also dropped.
  await env.DB.prepare(
    `DELETE FROM rel_edges
      WHERE id IN (
        SELECT s.id FROM rel_edges s
         WHERE s.src_entity_id = ?
           AND (
             s.dst_entity_id = ?  -- becomes self-loop after rewrite
             OR EXISTS (SELECT 1 FROM rel_edges p
                         WHERE p.src_entity_id = ?
                           AND p.dst_entity_id = s.dst_entity_id
                           AND p.kind = s.kind
                           AND IFNULL(p.valid_from,'') = IFNULL(s.valid_from,''))
           )
      )`,
  ).bind(secondary, primary, primary).run();
  await env.DB.prepare(
    `DELETE FROM rel_edges
      WHERE id IN (
        SELECT s.id FROM rel_edges s
         WHERE s.dst_entity_id = ?
           AND s.src_entity_id <> ?
           AND EXISTS (SELECT 1 FROM rel_edges p
                        WHERE p.dst_entity_id = ?
                          AND p.src_entity_id = s.src_entity_id
                          AND p.kind = s.kind
                          AND IFNULL(p.valid_from,'') = IFNULL(s.valid_from,''))
      )`,
  ).bind(secondary, primary, primary).run();

  // Pre-merge role union (also dedups so the final DELETE doesn't
  // resurrect roles via FK). We do this outside the batch because it
  // needs the secondary's role rows.
  const secRoles = await env.DB.prepare(`SELECT role, is_primary, source, confidence FROM entity_roles WHERE entity_id = ?`).bind(secondary).all<{ role: string; is_primary: number; source: string | null; confidence: number }>();
  for (const r of secRoles.results ?? []) {
    await env.DB.prepare(
      `INSERT INTO entity_roles (entity_id, role, is_primary, source, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, role) DO UPDATE SET
         is_primary = MAX(is_primary, excluded.is_primary),
         confidence = MAX(confidence, excluded.confidence)`,
    ).bind(primary, r.role, r.is_primary, r.source, r.confidence).run();
  }

  // Atomic body: D1.batch() runs the statements in a single SQLite
  // transaction, so any constraint abort rolls the whole merge back.
  const now = new Date().toISOString();
  const auditPrimaryId = crypto.randomUUID();
  const auditSecondaryId = crypto.randomUUID();
  const stmts = [
    env.DB.prepare(`UPDATE facts SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE channels SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE entity_tags SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE rel_edges SET src_entity_id = ? WHERE src_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE rel_edges SET dst_entity_id = ? WHERE dst_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE entity_legacy_map SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    // The 208 trigger requires merged_into NOT NULL together with status='merged',
    // so we set them in the same UPDATE.
    env.DB.prepare(`UPDATE u_entities SET merged_into_entity_id = ?, status = 'merged', updated_at = ? WHERE id = ?`).bind(primary, now, secondary),
    // Drop the secondary's summary row immediately so searchEntities
    // doesn't surface a now-merged entity until the queue worker fires.
    env.DB.prepare(`DELETE FROM entity_summary WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(
      `INSERT INTO entity_history (id, entity_id, action, source, related_entity_id) VALUES (?, ?, 'merge', 'system', ?)`,
    ).bind(auditPrimaryId, primary, secondary),
    env.DB.prepare(
      `INSERT INTO entity_history (id, entity_id, action, source, related_entity_id) VALUES (?, ?, 'merge', 'system', ?)`,
    ).bind(auditSecondaryId, secondary, primary),
  ];
  const results = await env.DB.batch(stmts);
  const factsMoved = Number(results[0]?.meta?.changes ?? 0);
  const channelsMoved = Number(results[1]?.meta?.changes ?? 0);
  const tagsMoved = Number(results[2]?.meta?.changes ?? 0);
  const edgesRewritten = Number(results[4]?.meta?.changes ?? 0) + Number(results[5]?.meta?.changes ?? 0);

  // Rebuild the primary's summary; secondary row was already deleted in
  // the batch above so the queue worker has nothing to do for it.
  await enqueueSummaryRebuild(env, primary);

  return {
    primary_id: primary,
    secondary_id: secondary,
    facts_moved: factsMoved,
    channels_moved: channelsMoved,
    tags_moved: tagsMoved,
    edges_rewritten: edgesRewritten,
  };
}

export async function mergeEntities(env: Env, idA: string, idB: string): Promise<MergeResult> {
  if (idA === idB) throw new Error("merge: cannot merge entity into itself");
  const { primary, secondary } = await pickPrimary(env, idA, idB);
  // Concurrency control: the merge body is already a single D1.batch()
  // transaction, so two interleaved merges can only race on read-then-
  // write ordering of pickPrimary, not on partial-state corruption.
  // Cross-request mutex via the EntityLock DO is a tracked followup
  // (the DO currently only exposes /merge_lead etc., not /acquire).
  return mergeCore(env, primary, secondary);
}
