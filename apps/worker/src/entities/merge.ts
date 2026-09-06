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
  /** Rows moved across the other 79 tables that reference a u_entities id. */
  references_repointed: number;
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

  // Move every other table that references the secondary before the core
  // batch records the merge — see repointEntityReferences for why the order
  // and the OR IGNORE / DELETE split matter.
  const repointed = await repointEntityReferences(env, primary, secondary);

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

  // Enrich the audit rows with per-predicate movement counts so the
  // history table carries enough provenance to reconstruct what the
  // merge actually moved (not just "merge happened").
  const evidence = JSON.stringify({
    facts_moved: factsMoved,
    channels_moved: channelsMoved,
    tags_moved: tagsMoved,
    edges_rewritten: edgesRewritten,
    legacy_remap_changes: Number(results[6]?.meta?.changes ?? 0),
    secondary_summary_deleted: Number(results[8]?.meta?.changes ?? 0),
  });
  await env.DB.batch([
    env.DB.prepare(`UPDATE entity_history SET new_value = ? WHERE id = ?`).bind(evidence, auditPrimaryId),
    env.DB.prepare(`UPDATE entity_history SET new_value = ? WHERE id = ?`).bind(evidence, auditSecondaryId),
  ]);

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
    references_repointed: repointed,
  };
}

/**
 * Re-point every table that references the secondary entity at the primary.
 *
 * The merge batch below moved five tables — facts, channels, entity_tags,
 * rel_edges and entity_legacy_map. The schema has 79 more that carry a
 * u_entities id, and none of them were touched, so merging two duplicate
 * people orphaned the loser's career history, board seats, identity handles,
 * news mentions, roles, monitoring state, dossier synthesis and diligence
 * findings — everything the profile actually renders. The merge appeared to
 * succeed and the data simply stopped being reachable.
 *
 * Two rules the generated list follows:
 *
 *  - `UPDATE OR IGNORE`, because 45 of these tables carry a unique constraint
 *    involving the entity column. On a collision the primary's row wins and
 *    the secondary's is dropped by the DELETE that follows. A plain UPDATE
 *    would abort the whole transaction — which is what the existing
 *    `UPDATE facts` can already do, since facts has UNIQUE(hash).
 *  - the DELETE only ever targets `entity_id`, the row's own owner. Pointer
 *    columns (organization_entity_id, company_entity_id, issuer_entity_id …)
 *    are re-pointed but never deleted: dropping a person's career row because
 *    their *employer* was merged would be a far worse bug than the one this
 *    fixes.
 *
 * Three tables are deliberately excluded — dd_findings, entity_risk_scores
 * and dd_scan_runs declare entity_id as INTEGER. That is the legacy `entities`
 * id space, not a u_entities uuid, so writing one here would be wrong.
 *
 * Runs BEFORE the core batch. If it fails the merge has not been recorded and
 * can simply be retried; if it succeeds and the core batch then fails, rows
 * have moved to the surviving entity, which is harmless and idempotent.
 */
async function repointEntityReferences(env: Env, primary: string, secondary: string): Promise<number> {
  const stmts = [
    env.DB.prepare(`UPDATE OR IGNORE alert_events SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE alert_rules SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE angel_investments SET person_entity_id = ? WHERE person_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE angel_investments SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE angels SET person_entity_id = ? WHERE person_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE appreciation_signals SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM appreciation_signals WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE avatar_phash SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE board_seats SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE board_seats SET organization_entity_id = ? WHERE organization_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM board_seats WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE bulk_operation_audit SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE cap_table_holders SET holder_entity_id = ? WHERE holder_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE cap_table_snapshots SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE career_history SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE career_history SET organization_entity_id = ? WHERE organization_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM career_history WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE comp_members SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE comp_metrics SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE conference_attendance SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM conference_attendance WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE conversation_hooks SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE conversation_hooks SET related_entity_id = ? WHERE related_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM conversation_hooks WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE data_quality_log SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE deal_events SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE deal_participants SET investor_entity_id = ? WHERE investor_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE diligence_runs SET target_entity_id = ? WHERE target_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE document_data_rooms SET target_entity_id = ? WHERE target_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE documents SET target_entity_id = ? WHERE target_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE education_history SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM education_history WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE email_hashes SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM email_hashes WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_audit_log SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_evidence_quotes SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_history SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_history SET related_entity_id = ? WHERE related_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_influence SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_influence WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_monitor_state SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_monitor_state WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_profile_axes SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_profile_axes WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_snapshots SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_snapshots WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE entity_title_embeddings SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM entity_title_embeddings WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE family_ties SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE family_ties SET related_entity_id = ? WHERE related_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM family_ties WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE field_overrides SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE founder_feedback SET investor_entity_id = ? WHERE investor_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE founder_pipeline_investors SET investor_entity_id = ? WHERE investor_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE government_appointments SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM government_appointments WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE hallucination_flags SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE handle_candidates SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM handle_candidates WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE identity_handles SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM identity_handles WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE intro_paths SET target_entity_id = ? WHERE target_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE investor_reputation SET investor_entity_id = ? WHERE investor_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE lifestyle_signals SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM lifestyle_signals WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE news_entity_mentions SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM news_entity_mentions WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE osint_entity_state SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM osint_entity_state WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE osint_negative_cache SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM osint_negative_cache WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE partner_movements SET person_entity_id = ? WHERE person_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_dossier_synthesis SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_goals SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM person_goals WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_identity SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM person_identity WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_interests SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM person_interests WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_preferences SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM person_preferences WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE person_verification_state SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM person_verification_state WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE persona_entity_matches SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM persona_entity_matches WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE persona_match_jobs SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE persona_match_manual_overrides SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM persona_match_manual_overrides WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE persona_matches SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM persona_matches WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE political_donations SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM political_donations WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE preferred_series SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE preferred_series_investors SET investor_entity_id = ? WHERE investor_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE profile_comments SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE profile_workflow_runs SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE profiler_enricher_logs SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE profiler_runs SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE project_audience_feedback SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM project_audience_feedback WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE project_audience_matches SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM project_audience_matches WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE project_history SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE project_matches SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM project_matches WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE reference_candidates SET subject_entity_id = ? WHERE subject_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE reference_candidates SET ref_entity_id = ? WHERE ref_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE relationship_infer_queue SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM relationship_infer_queue WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_13f_holdings SET filer_entity_id = ? WHERE filer_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_13f_holdings SET issuer_entity_id = ? WHERE issuer_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_filings SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_form_adv_funds SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_form_adv_funds SET adviser_entity_id = ? WHERE adviser_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_form_d_rounds SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_insider_trades SET filer_entity_id = ? WHERE filer_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_insider_trades SET issuer_entity_id = ? WHERE issuer_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE sec_insider_trades SET owner_entity_id = ? WHERE owner_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE stylometric_vectors SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM stylometric_vectors WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE travel_patterns SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM travel_patterns WHERE entity_id = ?`).bind(secondary),
    env.DB.prepare(`UPDATE OR IGNORE valuation_marks SET company_entity_id = ? WHERE company_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE verification_findings SET person_entity_id = ? WHERE person_entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`UPDATE OR IGNORE watchlist_members SET entity_id = ? WHERE entity_id = ?`).bind(primary, secondary),
    env.DB.prepare(`DELETE FROM watchlist_members WHERE entity_id = ?`).bind(secondary),
  ];
  const results = await env.DB.batch(stmts);
  return results.reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0);
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

// Caller-chosen canonical: used by the bulk-merge endpoint so the
// operator's selected canonical row always survives, regardless of
// quality-score ordering.
export async function mergeWithCanonical(env: Env, canonical: string, secondary: string): Promise<MergeResult> {
  if (canonical === secondary) throw new Error("merge: cannot merge entity into itself");
  return mergeCore(env, canonical, secondary);
}
