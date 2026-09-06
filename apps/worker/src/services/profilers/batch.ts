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
import { checkRateLimit, clearLastRun, setLastRun } from "./rateLimit";

/** Days a successful run keeps an entity out of the batch. Matches the
 *  route's 7-day per-entity rate limit so cron and operator share one
 *  cadence rather than fighting over it. */
const RESTALE_DAYS = 7;

export interface ProfilerBatchResult {
  scanned: number;
  dispatched: number;
  rate_limited: number;
  errors: number;
  mode: "workflow" | "inline";
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
           OR (SELECT MAX(r2.started_at) FROM profiler_runs r2
                WHERE r2.entity_id = u.id
                  AND r2.status IN ('succeeded','partial','privacy_skip')
              ) < datetime('now', ?)
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
  // Inline runs cost wall-clock in a shared cron tick, so the fallback
  // ceiling is much lower than the dispatch ceiling.
  const limit = hasWorkflow ? (opts?.limit ?? 25) : (opts?.inlineLimit ?? 3);
  const mode: "workflow" | "inline" = hasWorkflow ? "workflow" : "inline";

  // Enrichers call Workers AI through the shared daily neuron cap. Check
  // once up front rather than per entity — a batch that starts past the
  // cap has nothing useful to do.
  const budget = await assertBudget(env, "ai");
  if (!budget.ok) {
    return { scanned: 0, dispatched: 0, rate_limited: 0, errors: 0, mode, budget_skip: budget.reason };
  }

  const ids = await pickStalestProfilerTargets(env, limit);
  let dispatched = 0, rateLimited = 0, errors = 0;

  for (const entityId of ids) {
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
        .catch((e) => console.warn("profiler batch: queued-header insert failed", (e as Error).message));

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
      console.warn("profiler batch: entity failed", entityId, (e as Error).message);
    }
  }

  return { scanned: ids.length, dispatched, rate_limited: rateLimited, errors, mode };
}
