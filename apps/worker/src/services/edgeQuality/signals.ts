// Public-signal collectors for edge quality scoring.
//
// Each collector returns a RawSignal in [0, 1] plus the observed_at of
// the latest evidence backing it. Collectors that touch optional source
// tables are wrapped in safeQuery so the module degrades gracefully on
// environments where the table isn't populated (same pattern as Task
// #14 verification — missing source ≠ silent fallback, the signal is
// just absent from the bundle).

import type { Env } from "../../types";
import type { RawSignal, SignalKey } from "./aggregate";
import { logScale, maxDate, boardOverlapMonths, jaccardNeighbors } from "./signalScale";

export interface EdgeIdentity {
  src_entity_id: string;
  dst_entity_id: string;
}

async function safeQuery<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Co-investment count in the last 5y. Reads deal_participants. */
export async function signalCoInvestment(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const cutoff = new Date(Date.now() - 5 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(de.announced_date) AS last_date
         FROM deal_participants dp1
         JOIN deal_participants dp2 ON dp2.deal_id = dp1.deal_id
         JOIN deal_events de ON de.id = dp1.deal_id
        WHERE dp1.investor_entity_id = ?
          AND dp2.investor_entity_id = ?
          AND de.announced_date >= ?`,
    ).bind(e.src_entity_id, e.dst_entity_id, cutoff).first<{ n: number; last_date: string | null }>();
    if (!r || !r.n) return null;
    return { value: logScale(r.n, 10), observed_at: r.last_date ?? null };
  }, null);
}

/** Public co-mentions (joint quotes, joint podcasts). Reads entity_mentions. */
export async function signalCoMentions(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(DISTINCT m1.source_url) AS n, MAX(m1.observed_at) AS last_seen
         FROM entity_mentions m1
         JOIN entity_mentions m2 ON m2.source_url = m1.source_url
        WHERE m1.entity_id = ? AND m2.entity_id = ?
          AND m1.entity_id != m2.entity_id`,
    ).bind(e.src_entity_id, e.dst_entity_id).first<{ n: number; last_seen: string | null }>();
    if (!r || !r.n) return null;
    return { value: logScale(r.n, 8), observed_at: r.last_seen ?? null };
  }, null);
}

/**
 * Board time-overlap. Reads facts (predicate=person.board_seat).
 *
 * The JSON paths must match what `entities/profile.ts::addBoardSeat`
 * actually mirrors — `organization_entity_id` / `started_at` / `ended_at`.
 * This read used to ask for `company_entity_id` / `start_date` / `end_date`,
 * which no writer has ever produced, so the join never matched and the
 * signal returned a silent null on every edge.
 *
 * Matching those names was necessary but not sufficient. `addBoardSeat`
 * requires `organization_name` and always mirrors it, but
 * `organization_entity_id` is nullable and no producer upstream of the
 * board-seat enricher resolves one — so joining on the id alone still
 * matched nothing. The join prefers the resolved id and falls back to the
 * name, the same shape the school half of signalSameFirmOrSchool already
 * uses (it joins on `institution`, a name, for exactly this reason).
 */
export async function signalBoardOverlap(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT
         json_extract(f1.value_json, '$.started_at') AS s1,
         json_extract(f1.value_json, '$.ended_at') AS e1,
         json_extract(f2.value_json, '$.started_at') AS s2,
         json_extract(f2.value_json, '$.ended_at') AS e2
       FROM facts f1
       JOIN facts f2 ON COALESCE(json_extract(f2.value_json, '$.organization_entity_id'),
                                 json_extract(f2.value_json, '$.organization_name'))
                      = COALESCE(json_extract(f1.value_json, '$.organization_entity_id'),
                                 json_extract(f1.value_json, '$.organization_name'))
      WHERE f1.entity_id = ? AND f2.entity_id = ?
        AND f1.predicate = 'person.board_seat' AND f2.predicate = 'person.board_seat'
        AND COALESCE(json_extract(f1.value_json, '$.organization_entity_id'),
                     json_extract(f1.value_json, '$.organization_name')) IS NOT NULL
        AND f1.is_current = 1 AND f2.is_current = 1`,
    ).bind(e.src_entity_id, e.dst_entity_id).all<{ s1: string | null; e1: string | null; s2: string | null; e2: string | null }>();
    const rows = r.results ?? [];
    if (!rows.length) return null;
    let totalMonths = 0;
    let latest: string | null = null;
    for (const row of rows) {
      totalMonths += boardOverlapMonths(row.s1, row.e1, row.s2, row.e2);
      latest = maxDate(latest, row.e1);
      latest = maxDate(latest, row.e2);
    }
    if (totalMonths === 0) return null;
    return { value: logScale(totalMonths, 36), observed_at: latest };
  }, null);
}

/** Public reply rate on Twitter/X. Reads social_interactions (optional). */
export async function signalTwitterReplyRate(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(observed_at) AS last_seen
         FROM social_interactions
        WHERE platform = 'twitter'
          AND src_entity_id = ? AND dst_entity_id = ?
          AND interaction_kind IN ('reply','quote_tweet')`,
    ).bind(e.src_entity_id, e.dst_entity_id).first<{ n: number; last_seen: string | null }>();
    if (!r || !r.n) return null;
    return { value: logScale(r.n, 20), observed_at: r.last_seen ?? null };
  }, null);
}

/** LinkedIn endorsements (direction + recency). Reads linkedin_endorsements (optional). */
export async function signalLinkedInEndorsements(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(observed_at) AS last_seen
         FROM linkedin_endorsements
        WHERE endorser_entity_id = ? AND endorsee_entity_id = ?`,
    ).bind(e.src_entity_id, e.dst_entity_id).first<{ n: number; last_seen: string | null }>();
    if (!r || !r.n) return null;
    return { value: logScale(r.n, 5), observed_at: r.last_seen ?? null };
  }, null);
}

/** Joint conference panels. Reads conference_attendees (optional). */
export async function signalJointPanels(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(DISTINCT a1.event_id) AS n, MAX(a1.event_date) AS last_seen
         FROM conference_attendees a1
         JOIN conference_attendees a2 ON a2.event_id = a1.event_id
        WHERE a1.entity_id = ? AND a2.entity_id = ?
          AND (a1.role IN ('speaker','panelist') OR a2.role IN ('speaker','panelist'))`,
    ).bind(e.src_entity_id, e.dst_entity_id).first<{ n: number; last_seen: string | null }>();
    if (!r || !r.n) return null;
    return { value: logScale(r.n, 5), observed_at: r.last_seen ?? null };
  }, null);
}

/**
 * Same firm or school overlap. Reads facts (person.career / person.education).
 *
 * Three separate name drifts made this signal unreachable:
 *
 *   - predicate `person.career_entry` is a *verification claim* predicate
 *     (services/verification/runner.ts), never a `facts` row. The canonical
 *     fact predicate — registered in entities/profile-predicates.ts and
 *     written by both entities/profile.ts and services/secEdgar/persist.ts —
 *     is `person.career`.
 *   - the employer id is `organization_entity_id` (profile.ts) or
 *     `employer_entity_id` (secEdgar/persist.ts), never `firm_entity_id`.
 *     Both shapes are live in the table, so both are coalesced here.
 *   - the school is `institution` (profile.ts), never `school_name`.
 *
 * The explicit IS NOT NULL guards are not load-bearing — SQLite evaluates
 * `NULL = NULL` to NULL, so a pair of id-less rows never joins anyway — but
 * organization_entity_id is nullable on both writers, and stating the
 * requirement beats relying on three-valued logic to hold by accident.
 */
export async function signalSameFirmOrSchool(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*)
            FROM facts f1
            JOIN facts f2 ON COALESCE(json_extract(f2.value_json, '$.organization_entity_id'),
                                      json_extract(f2.value_json, '$.employer_entity_id'))
                           = COALESCE(json_extract(f1.value_json, '$.organization_entity_id'),
                                      json_extract(f1.value_json, '$.employer_entity_id'))
           WHERE f1.entity_id = ? AND f2.entity_id = ?
             AND f1.predicate = 'person.career'
             AND f2.predicate = 'person.career'
             AND COALESCE(json_extract(f1.value_json, '$.organization_entity_id'),
                          json_extract(f1.value_json, '$.employer_entity_id')) IS NOT NULL
             AND f1.is_current = 1 AND f2.is_current = 1) AS firm_overlap,
         (SELECT COUNT(*)
            FROM facts f1
            JOIN facts f2 ON json_extract(f2.value_json, '$.institution')
                           = json_extract(f1.value_json, '$.institution')
           WHERE f1.entity_id = ? AND f2.entity_id = ?
             AND f1.predicate = 'person.education'
             AND f2.predicate = 'person.education'
             AND json_extract(f1.value_json, '$.institution') IS NOT NULL
             AND f1.is_current = 1 AND f2.is_current = 1) AS school_overlap`,
    ).bind(e.src_entity_id, e.dst_entity_id, e.src_entity_id, e.dst_entity_id)
      .first<{ firm_overlap: number; school_overlap: number }>();
    if (!r) return null;
    const total = (r.firm_overlap ?? 0) + (r.school_overlap ?? 0);
    if (total === 0) return null;
    // Static — no decay timestamp; treat as "current" so no decay applied.
    return { value: Math.min(1, total / 3), observed_at: null };
  }, null);
}

/** Mutual-connections Jaccard on rel_edges neighbors. */
export async function signalMutualJaccard(env: Env, e: EdgeIdentity): Promise<RawSignal | null> {
  return safeQuery(async () => {
    const [a, b] = await Promise.all([
      env.DB.prepare(
        `SELECT DISTINCT
           CASE WHEN src_entity_id = ? THEN dst_entity_id ELSE src_entity_id END AS nbr
           FROM rel_edges
          WHERE (src_entity_id = ? OR dst_entity_id = ?)`,
      ).bind(e.src_entity_id, e.src_entity_id, e.src_entity_id).all<{ nbr: string }>(),
      env.DB.prepare(
        `SELECT DISTINCT
           CASE WHEN src_entity_id = ? THEN dst_entity_id ELSE src_entity_id END AS nbr
           FROM rel_edges
          WHERE (src_entity_id = ? OR dst_entity_id = ?)`,
      ).bind(e.dst_entity_id, e.dst_entity_id, e.dst_entity_id).all<{ nbr: string }>(),
    ]);
    const exclude = new Set([e.src_entity_id, e.dst_entity_id]);
    const aNbrs = (a.results ?? []).map((r) => r.nbr);
    const bNbrs = (b.results ?? []).map((r) => r.nbr);
    const j = jaccardNeighbors(aNbrs, bNbrs, exclude);
    if (j === 0) return null;
    return { value: j, observed_at: null };
  }, null);
}

export async function collectAllSignals(
  env: Env,
  e: EdgeIdentity,
): Promise<Partial<Record<SignalKey, RawSignal>>> {
  const [co, mt, bd, tw, li, jp, sf, mj] = await Promise.all([
    signalCoInvestment(env, e),
    signalCoMentions(env, e),
    signalBoardOverlap(env, e),
    signalTwitterReplyRate(env, e),
    signalLinkedInEndorsements(env, e),
    signalJointPanels(env, e),
    signalSameFirmOrSchool(env, e),
    signalMutualJaccard(env, e),
  ]);
  const out: Partial<Record<SignalKey, RawSignal>> = {};
  if (co) out.co_investment_5y = co;
  if (mt) out.public_co_mentions = mt;
  if (bd) out.board_time_overlap = bd;
  if (tw) out.twitter_reply_rate = tw;
  if (li) out.linkedin_endorsements = li;
  if (jp) out.joint_panels = jp;
  if (sf) out.same_firm_or_school = sf;
  if (mj) out.mutual_jaccard = mj;
  return out;
}

