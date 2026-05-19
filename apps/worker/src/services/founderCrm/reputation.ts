// Task #5: Investor reputation aggregation.
//
// Five signal collectors + a single aggregator that writes one
// `investor_reputation` row per investor. Each collector is pure
// (accepts pre-fetched rows) so the math can be unit-tested in
// isolation. The DB-bound runner `recomputeInvestorReputation`
// gathers the inputs and persists the result.
//
// Per the Task #1 canonical write contract, derived investor facts
// (`investor.speed_to_no_days_median`, `investor.follow_on_rate_pct`,
// `investor.term_aggressiveness_pct`, `investor.board_behavior_score`,
// `investor.founder_nps`) mirror onto the investor entity via
// insertFact with `source_kind="inferred"` and
// `source="founder_crm:reputation"`. The application layer never
// INSERTs into facts directly.
//
// Min-sample gate: aggregates are written to the row regardless of
// sample size, but `is_public=0` and `low_sample=1` when sample_size
// < 5. The route handler is responsible for filtering the public
// projection — non-admin callers see null/redacted fields when
// is_public=0.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";

export const MIN_PUBLIC_SAMPLE = 5;

// ── Pure signal helpers ──────────────────────────────────────────────

/** Median over an integer/float array. Returns null for empty input. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const xs = values.slice().sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Speed-to-no signal. Inputs are days-from-first-contact-to-pass.
 *  Returns { median, n }. Null when there are no observations. */
export function speedToNo(daysList: Array<number | null | undefined>): { median: number | null; n: number } {
  const xs = daysList.filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d >= 0);
  return { median: median(xs), n: xs.length };
}

/** Follow-on rate signal: % of seed companies the investor backed
 *  that they also participated in at Series A. Both numerator and
 *  denominator are precomputed by the DB query to keep this pure. */
export function followOnRate(seedCompanies: number, followedOn: number): { pct: number | null; n: number } {
  if (seedCompanies <= 0) return { pct: null, n: 0 };
  return { pct: Math.min(1, followedOn / seedCompanies), n: seedCompanies };
}

/** Board-behavior score: mean of rating-NPS in [-100,100] mapped to
 *  [0,1] via (nps + 100) / 200. NULL when sample empty. */
export function boardBehaviorScore(ratings: number[]): number | null {
  if (!ratings.length) return null;
  const nps = founderNps(ratings);
  if (nps == null) return null;
  return (nps + 100) / 200;
}

/** Founder NPS over behavior_rating in [1..5]:
 *    promoters  = rating >= 4 → +1
 *    detractors = rating <= 2 → -1
 *    passives   = rating == 3 → 0
 *  NPS = (promoters - detractors) / n * 100, range [-100, 100]. */
export function founderNps(ratings: number[]): number | null {
  if (!ratings.length) return null;
  let p = 0, d = 0;
  for (const r of ratings) {
    if (r >= 4) p += 1;
    else if (r <= 2) d += 1;
  }
  return ((p - d) / ratings.length) * 100;
}

/** Term-aggressiveness percentile within a peer cohort. `peers`
 *  is the array of cohort scores including the focal investor.
 *  Returns 0..1 — fraction of peers with score strictly less than
 *  the focal score. */
export function termAggressivenessPercentile(focal: number | null, peers: number[]): number | null {
  if (focal == null || !peers.length) return null;
  const below = peers.filter((p) => p < focal).length;
  return below / peers.length;
}

// ── Aggregator: builds the public reputation row from collectors ──

export interface ReputationInputs {
  feedbackRatings: number[];          // behavior_rating from founder_feedback
  feedbackSpeedToNo: number[];        // speed_to_no_days from founder_feedback
  renegedCount: number;               // raise_outcome='reneged' count
  seedCompanies: number;
  followedOn: number;
  aggressivenessScore: number | null; // from computeInvestorAggressiveness().score
  aggressivenessPeers: number[];      // cohort scores for percentile
  portfolioConflicts: number;
}

export interface ReputationAggregate {
  speed_to_no_days_median: number | null;
  speed_to_no_n: number;
  term_aggressiveness_pct: number | null;
  follow_on_rate_pct: number | null;
  follow_on_n: number;
  board_behavior_score: number | null;
  founder_nps: number | null;
  reneged_term_sheets_count: number;
  portfolio_conflict_count: number;
  sample_size: number;
  is_public: number;
  low_sample: number;
}

export function aggregateReputation(inp: ReputationInputs): ReputationAggregate {
  const speed = speedToNo(inp.feedbackSpeedToNo);
  const follow = followOnRate(inp.seedCompanies, inp.followedOn);
  const nps = founderNps(inp.feedbackRatings);
  const board = boardBehaviorScore(inp.feedbackRatings);
  const aggrPct = termAggressivenessPercentile(inp.aggressivenessScore, inp.aggressivenessPeers);
  const sample = inp.feedbackRatings.length;
  const isPublic = sample >= MIN_PUBLIC_SAMPLE ? 1 : 0;
  return {
    speed_to_no_days_median: speed.median,
    speed_to_no_n: speed.n,
    term_aggressiveness_pct: aggrPct,
    follow_on_rate_pct: follow.pct,
    follow_on_n: follow.n,
    board_behavior_score: board,
    founder_nps: nps,
    reneged_term_sheets_count: inp.renegedCount,
    portfolio_conflict_count: inp.portfolioConflicts,
    sample_size: sample,
    is_public: isPublic,
    low_sample: isPublic ? 0 : 1,
  };
}

// ── DB-bound runner ─────────────────────────────────────────────────

async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch { return []; }
}

async function safeFirst<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try { return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null; }
  catch { return null; }
}

/** Compute and persist the reputation aggregate for a single investor. */
export async function recomputeInvestorReputation(env: Env, investorEntityId: string): Promise<ReputationAggregate> {
  // Founder feedback signals.
  const fb = await safeAll<{ behavior_rating: number; speed_to_no_days: number | null; raise_outcome: string | null }>(
    env,
    `SELECT behavior_rating, speed_to_no_days, raise_outcome
       FROM founder_feedback WHERE investor_entity_id = ?`,
    investorEntityId,
  );
  const feedbackRatings = fb.map((r) => r.behavior_rating).filter((n): n is number => typeof n === "number");
  const feedbackSpeedToNo = fb.map((r) => r.speed_to_no_days).filter((n): n is number => typeof n === "number" && n >= 0);
  const renegedCount = fb.filter((r) => r.raise_outcome === "reneged").length;

  // Follow-on rate. seedCompanies = distinct companies where investor
  // participated in a Seed/Pre-Seed round; followedOn = subset where
  // the same investor also participated in a later Series A round
  // for the same company. Degrades gracefully when deal_events /
  // deal_participants are missing.
  const seedRows = await safeAll<{ company_entity_id: string }>(
    env,
    `SELECT DISTINCT de.company_entity_id AS company_entity_id
       FROM deal_participants dp
       JOIN deal_events       de ON de.id = dp.deal_id
      WHERE dp.investor_entity_id = ?
        AND de.event_type = 'funding_round'
        AND (LOWER(de.round_name) LIKE 'seed%' OR LOWER(de.round_name) LIKE 'pre-seed%' OR LOWER(de.round_name) LIKE 'pre seed%')
        AND de.company_entity_id IS NOT NULL`,
    investorEntityId,
  );
  let followedOn = 0;
  for (const s of seedRows) {
    const a = await safeFirst<{ n: number }>(
      env,
      `SELECT COUNT(*) AS n
         FROM deal_participants dp
         JOIN deal_events       de ON de.id = dp.deal_id
        WHERE dp.investor_entity_id = ?
          AND de.company_entity_id = ?
          AND LOWER(de.round_name) LIKE 'series a%'`,
      investorEntityId, s.company_entity_id,
    );
    if ((a?.n ?? 0) > 0) followedOn += 1;
  }
  const seedCompanies = seedRows.length;

  // Term aggressiveness via Task #18 — both the focal score and a peer
  // cohort drawn from the same investor's stage band. Wrapped so a
  // fresh DB without the preferred-stack tables (Task #18) degrades.
  let aggressivenessScore: number | null = null;
  let aggressivenessPeers: number[] = [];
  try {
    const { computeInvestorAggressiveness } = await import("../termSheets/aggressiveness");
    const r = await computeInvestorAggressiveness(env, investorEntityId);
    if (r.series_count > 0) aggressivenessScore = r.score;
    // Peer cohort: every investor with >=2 scored series. Bounded
    // at 500 so a pathological DB doesn't blow CPU.
    const peers = await safeAll<{ investor_entity_id: string; n: number }>(
      env,
      `SELECT psi.investor_entity_id, COUNT(*) AS n
         FROM preferred_series_investors psi
         JOIN preferred_series ps ON ps.id = psi.series_id
        WHERE ps.is_current = 1
        GROUP BY psi.investor_entity_id
        HAVING n >= 2
        LIMIT 500`,
    );
    for (const p of peers) {
      try {
        const pa = await computeInvestorAggressiveness(env, p.investor_entity_id);
        if (pa.series_count > 0) aggressivenessPeers.push(pa.score);
      } catch { /* ignore */ }
    }
  } catch { /* term sheets module unavailable */ }

  // Portfolio conflicts: count of distinct companies in this investor's
  // portfolio that share a primary sector with another portco. Best-
  // effort signal — wrapped so missing `entity_summaries.sector` doesn't
  // throw.
  const conflictRow = await safeFirst<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM (
       SELECT de.company_entity_id
         FROM deal_participants dp
         JOIN deal_events de ON de.id = dp.deal_id
        WHERE dp.investor_entity_id = ?
          AND de.company_entity_id IS NOT NULL
        GROUP BY de.company_entity_id
     )`,
    investorEntityId,
  );
  const portfolioConflicts = Math.max(0, (conflictRow?.n ?? 0) - 1); // crude proxy until Task #109 lands

  const agg = aggregateReputation({
    feedbackRatings,
    feedbackSpeedToNo,
    renegedCount,
    seedCompanies,
    followedOn,
    aggressivenessScore,
    aggressivenessPeers,
    portfolioConflicts,
  });

  // Persist row.
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO investor_reputation (
       investor_entity_id, speed_to_no_days_median, term_aggressiveness_pct,
       follow_on_rate_pct, board_behavior_score, founder_nps,
       reneged_term_sheets_count, portfolio_conflict_count,
       sample_size, speed_to_no_n, follow_on_n, is_public, low_sample, computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(investor_entity_id) DO UPDATE SET
       speed_to_no_days_median = excluded.speed_to_no_days_median,
       term_aggressiveness_pct = excluded.term_aggressiveness_pct,
       follow_on_rate_pct = excluded.follow_on_rate_pct,
       board_behavior_score = excluded.board_behavior_score,
       founder_nps = excluded.founder_nps,
       reneged_term_sheets_count = excluded.reneged_term_sheets_count,
       portfolio_conflict_count = excluded.portfolio_conflict_count,
       sample_size = excluded.sample_size,
       speed_to_no_n = excluded.speed_to_no_n,
       follow_on_n = excluded.follow_on_n,
       is_public = excluded.is_public,
       low_sample = excluded.low_sample,
       computed_at = excluded.computed_at`,
  ).bind(
    investorEntityId,
    agg.speed_to_no_days_median, agg.term_aggressiveness_pct,
    agg.follow_on_rate_pct, agg.board_behavior_score, agg.founder_nps,
    agg.reneged_term_sheets_count, agg.portfolio_conflict_count,
    agg.sample_size, agg.speed_to_no_n, agg.follow_on_n,
    agg.is_public, agg.low_sample, now,
  ).run();

  // Mirror derived facts onto the investor entity per Task #1 contract.
  // source_kind="inferred" — same precedent as Task #2/#3 model output.
  // Only mirror the *public* aggregates (is_public=1); below the
  // 5-review gate we keep the row but do not publish facts.
  if (agg.is_public) {
    const factSrc = "founder_crm:reputation";
    const mirror: Array<[string, number | null]> = [
      ["investor.speed_to_no_days_median", agg.speed_to_no_days_median],
      ["investor.follow_on_rate_pct", agg.follow_on_rate_pct],
      ["investor.term_aggressiveness_pct", agg.term_aggressiveness_pct],
      ["investor.board_behavior_score", agg.board_behavior_score],
      ["investor.founder_nps", agg.founder_nps],
    ];
    for (const [predicate, value] of mirror) {
      if (value == null) continue;
      try {
        await insertFact(env, {
          entity_id: investorEntityId,
          predicate,
          value_number: value,
          source_kind: "inferred",
          source: factSrc,
        });
      } catch (e) {
        console.warn("reputation insertFact failed", predicate, (e as Error).message);
      }
    }
  }

  return agg;
}

/** Nightly sweep. Recomputes reputation for every investor with at
 *  least one founder_feedback row OR at least one deal_participants
 *  row in the last 365 days. Bounded at 1000 investors/tick. */
export async function runNightlyReputationSweep(env: Env, ceiling = 1000): Promise<{ updated: number }> {
  const rows = await safeAll<{ investor_entity_id: string }>(
    env,
    `SELECT investor_entity_id FROM (
       SELECT investor_entity_id FROM founder_feedback
       UNION
       SELECT DISTINCT dp.investor_entity_id
         FROM deal_participants dp
         JOIN deal_events de ON de.id = dp.deal_id
        WHERE dp.investor_entity_id IS NOT NULL
          AND de.announcement_date >= date('now','-365 days')
     ) WHERE investor_entity_id IS NOT NULL
     LIMIT ?`,
    ceiling,
  );
  let n = 0;
  for (const r of rows) {
    try { await recomputeInvestorReputation(env, r.investor_entity_id); n += 1; }
    catch (e) { console.warn("reputation recompute failed", r.investor_entity_id, (e as Error).message); }
  }
  return { updated: n };
}
