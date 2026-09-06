// Nightly driver for the individual person profiler.
//
// `runProfiler` was reachable from exactly two places: POST
// /api/profilers/:entity_id/run and the Workflow class that route
// dispatches. Nothing scheduled it. So `career_history`,
// `education_history`, `board_seats`, `interests`, `conversation_hooks`
// and the rest of the structured person tables only ever filled for
// entities an operator had personally clicked — which starves six of the
// thirteen relationship-edge extractors, and with them `rel_edges`,
// `entity_influence` and the Power Nodes page.
//
// This is the missing driver. It deliberately dispatches one Workflow
// instance per entity rather than running the profiler inline: a single
// profiler run has a 60 s deadline and the nightly cron slot already
// carries ~38 sweeps, so N inline runs would be the one job able to
// starve every job after it. Dispatch is a few milliseconds per entity
// and each run then survives instance restarts on its own.

import type { Env } from "../../types";
import { assertBudget } from "../../ai/budget";
import { logError } from "../../db/error_log";
import { wrapUnknown } from "../../errors";
import { checkRateLimit, clearLastRun, setLastRun } from "./rateLimit";

/** Days a successful run keeps an entity out of the batch. Matches the
 *  route's 7-day per-entity rate limit so cron and operator share one
 *  cadence rather than fighting over it. */
const RESTALE_DAYS = 7;

/**
 * How many candidates to consider per dispatch slot.
 *
 * The SQL gate and the KV limiter do not agree, deliberately: SQL counts only
 * runs that finished ('succeeded','partial','privacy_skip'), while KV stamps
 * on *dispatch*. An entity whose run was dispatched and then failed is
 * therefore SQL-eligible and KV-blocked for a full week — and because it has
 * no successful run it sorts to the very front of the ORDER BY every night.
 * Taking exactly `limit` candidates let a single bad night (a Workflows quota,
 * a bad deploy) fill every slot with entities that can only be skipped, and
 * the driver would dispatch nothing for seven days while never-profiled people
 * queued behind them. So over-fetch and stop counting at `limit` *dispatches*.
 */
const CANDIDATE_OVERFETCH = 3;

/**
 * Floor on candidates fetched, regardless of how small `limit` is.
 *
 * A multiplier alone is not enough: at limit=1 a 3x over-fetch returns three
 * candidates, and if the three at the front of the queue are all blocked the
 * batch still dispatches nothing. The blocked prefix is bounded by roughly
 * one night's dispatches, so a fixed floor clears it at any limit. Keep it
 * well under the subrequest ceiling — at small limits the cost is
 * MIN_CANDIDATES reads plus 4 per dispatch, which is trivial; at limits above
 * ~9 the multiplier dominates again and MAX_PROFILER_BATCH governs.
 */
const MIN_CANDIDATES = 25;

/**
 * Cloudflare counts D1/KV/Workflow binding calls cumulatively per invocation.
 * This batch spends 1 KV read per candidate examined, plus 4 more per entity
 * actually dispatched (KV write, D1 insert, Workflow create, D1 update), so
 * the worst case is `limit * (CANDIDATE_OVERFETCH + 4)`. Keep that under the
 * same 700 ceiling the crawl and import paths use — see
 * scraper/subrequestBudget.ts. Exceeding it does not degrade: the invocation
 * throws mid-loop, and because `clearLastRun` is itself a KV call it cannot
 * roll back either, so every remaining entity keeps a 7-day stamp for a run
 * that never happened.
 */
export const MAX_PROFILER_BATCH = Math.floor(700 / (CANDIDATE_OVERFETCH + 4)); // 100

export interface ProfilerBatchResult {
  /** Candidates actually examined (not the number fetched). */
  scanned: number;
  dispatched: number;
  rate_limited: number;
  errors: number;
  mode: "workflow" | "inline";
  /** The limit after clamping — never larger than what the mode can afford. */
  effective_limit: number;
  budget_skip?: string;
}

/**
 * Person entities most in need of a profiler run: never profiled first,
 * then oldest run.
 *
 * `EXISTS (SELECT 1 FROM facts ...)` is not a micro-optimisation — every
 * enricher in the registry reads `facts` as its primary source, so an
 * entity with none produces an empty dossier and a wasted 60 s slot.
 * It excludes only genuinely empty placeholder rows; dualwrite gives any
 * real entity a name fact on creation.
 */
export async function pickStalestProfilerTargets(env: Env, limit: number): Promise<string[]> {
  // `datetime(...)` around the MAX is load-bearing. Every writer stamps
  // started_at with `new Date().toISOString()` — "2026-08-30T06:16:21.111Z" —
  // while `datetime('now', ?)` yields "2026-08-30 06:16:21". Comparing those
  // raw is a string compare, and 'T' (0x54) sorts above ' ' (0x20), so a run
  // only reads as stale once its calendar date is strictly earlier than the
  // cutoff's. The gate silently behaved as ~8 days rather than RESTALE_DAYS.
  const rows = await env.DB.prepare(
    `SELECT u.id,
            (SELECT MAX(r.started_at) FROM profiler_runs r
              WHERE r.entity_id = u.id AND r.status IN ('succeeded','partial','privacy_skip')
            ) AS last_run
       FROM u_entities u
      WHERE u.kind = 'person'
        AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = u.id)
        AND (
              (SELECT MAX(r2.started_at) FROM profiler_runs r2
                WHERE r2.entity_id = u.id
                  AND r2.status IN ('succeeded','partial','privacy_skip')
              ) IS NULL
           OR datetime((SELECT MAX(r2.started_at) FROM profiler_runs r2
                WHERE r2.entity_id = u.id
                  AND r2.status IN ('succeeded','partial','privacy_skip')
              )) < datetime('now', ?)
        )
      ORDER BY (last_run IS NULL) DESC, last_run ASC
      LIMIT ?`,
  ).bind(`-${RESTALE_DAYS} days`, limit).all<{ id: string; last_run: string | null }>();
  return (rows.results ?? []).map((r) => r.id);
}

/**
 * Dispatch a bounded batch of profiler runs.
 *
 * Ordering of the two gates matters. The SQL gate above is authoritative
 * for "has this entity been profiled recently", but a run dispatched last
 * night that has not yet written its row would slip past it — so the KV
 * limiter the route uses is checked too, and stamped at dispatch. A
 * dispatch that throws clears the stamp again, exactly as the route does:
 * without that, one transient Workflow error would lock an entity out of
 * the profiler for a week.
 */
export async function runStalestProfilerBatch(
  env: Env,
  opts?: { limit?: number; inlineLimit?: number },
): Promise<ProfilerBatchResult> {
  const wf = env.WF_PROFILER_INDIVIDUAL;
  const hasWorkflow = Boolean(wf && typeof wf.create === "function");
  const mode: "workflow" | "inline" = hasWorkflow ? "workflow" : "inline";
  // Inline runs await runProfiler synchronously — up to ~60 s of wall clock
  // each — so the fallback ceiling is far lower than the dispatch ceiling.
  // The caller's limit is honoured as an upper bound in BOTH modes: dropping
  // it in inline mode meant `{"limit":500}` processed 3 entities while the
  // route reported 500 back.
  const ceiling = hasWorkflow ? MAX_PROFILER_BATCH : (opts?.inlineLimit ?? 3);
  const limit = Math.max(1, Math.min(opts?.limit ?? (hasWorkflow ? 25 : 3), ceiling));

  // Enrichers call Workers AI through the shared daily neuron cap. Check
  // once up front rather than per entity — a batch that starts past the
  // cap has nothing useful to do.
  const budget = await assertBudget(env, "ai");
  if (!budget.ok) {
    return { scanned: 0, dispatched: 0, rate_limited: 0, errors: 0, mode, effective_limit: limit, budget_skip: budget.reason };
  }

  const candidates = await pickStalestProfilerTargets(
    env, Math.max(limit * CANDIDATE_OVERFETCH, MIN_CANDIDATES),
  );
  let scanned = 0, dispatched = 0, rateLimited = 0, errors = 0;

  for (const entityId of candidates) {
    if (dispatched >= limit) break;
    scanned += 1;
    try {
      const rl = await checkRateLimit(env, entityId);
      if (!rl.allowed) { rateLimited += 1; continue; }

      const runId = crypto.randomUUID();
      const queuedAt = new Date().toISOString();
      await setLastRun(env, entityId, { runId, startedAt: queuedAt });

      // Insert the header before dispatch so the workflow_run_id update
      // always lands on a real row — same reason the route does it.
      await env.DB.prepare(
        `INSERT INTO profiler_runs
           (id, entity_id, status, triggered_by, force_refresh, started_at)
           VALUES (?, ?, 'queued', 'cron:nightly', 0, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(runId, entityId, queuedAt).run()
        .catch((e) => logError(env, {
          err: wrapUnknown(e, "db_error", { entity_id: entityId, run_id: runId }),
          step: "profiler_batch.queued_header",
          job_id: runId,
        }));

      try {
        if (hasWorkflow) {
          const inst = await wf!.create({
            params: { entityId, runId, triggeredBy: "cron:nightly", forceRefresh: false, viewerEntityId: null },
          });
          await env.DB.prepare(`UPDATE profiler_runs SET workflow_run_id = ? WHERE id = ?`)
            .bind(inst.id, runId).run().catch(() => undefined);
        } else {
          const { runProfiler } = await import("./orchestrator.js");
          await runProfiler(env, entityId, { runId, triggeredBy: "cron:nightly", viewerEntityId: null });
        }
        dispatched += 1;
      } catch (e) {
        // Never leave an entity rate-limited for a run that did not start.
        await clearLastRun(env, entityId);
        throw e;
      }
    } catch (e) {
      errors += 1;
      // The entity id rides in the AppError context rather than in `step`:
      // error clustering groups on `step`, so a per-entity value there would
      // fragment every batch failure into its own singleton cluster.
      await logError(env, {
        err: wrapUnknown(e, "internal_error", { entity_id: entityId }),
        step: "profiler_batch.entity",
      });
    }
  }

  return { scanned, dispatched, rate_limited: rateLimited, errors, mode, effective_limit: limit };
}
