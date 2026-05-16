// Task #2: operational admin endpoints. All routes gated by the existing
// accessGuard middleware (the email allowlist), mounted under /api/admin.
//
//   POST /api/admin/clear-stuck-jobs   sweep `running` jobs past budget_ms
//                                      to `timed_out`. Returns a count.
//   POST /api/admin/repair-pipeline    idempotent end-to-end repair:
//                                      (1) clear stuck jobs,
//                                      (2) re-enqueue summary rebuilds for
//                                          entities flagged stale by the
//                                          last 24h of mutations,
//                                      (3) ack the run in repair_runs.
//   POST /api/admin/rebuild-summary    enqueue a single entity_id rebuild,
//                                      or {all:true} to enqueue every
//                                      active entity in batches of 200.
//   GET  /api/admin/queue-health       cheap roll-up used by the dashboard:
//                                      depth, stuck count, oldest age.

import { Hono } from "hono";
import type { Env } from "../types";
import { backfillAll } from "../entities/backfill";
import { enqueueSummaryRebuild } from "../entities/summaryQueue";
import { logError } from "../db/error_log";
import { AppError } from "../errors";

export const admin = new Hono<{ Bindings: Env; Variables: { email: string } }>();

/**
 * Sweep `running` jobs whose elapsed time exceeds their `budget_ms`. We
 * compute the cutoff in SQLite rather than fetching every row into the
 * worker: D1's strftime('%s', ...) returns the unix timestamp of the
 * given ISO string, and we compare against now in ms.
 *
 * The transition `running -> timed_out` is allowed by the state-machine
 * trigger in migration 193.
 */
export async function sweepStuckJobs(env: Env): Promise<number> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE jobs
       SET status = 'timed_out',
           finished_at = ?,
           error = COALESCE(error, 'budget_exceeded')
     WHERE status = 'running'
       AND running_started_at IS NOT NULL
       AND budget_ms IS NOT NULL
       AND (strftime('%s', ?) - strftime('%s', running_started_at)) * 1000 > budget_ms`,
  ).bind(now, now).run();
  const swept = Number(r.meta?.changes ?? 0);
  if (swept > 0) {
    // Log a state-transition row per swept job so /api/jobs/:id shows the
    // sweep in its history. One bulk INSERT...SELECT keeps this cheap.
    await env.DB.prepare(
      `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by)
       SELECT id, 'running', 'timed_out', 'budget_exceeded', 'admin.sweep'
         FROM jobs WHERE status = 'timed_out' AND finished_at = ?`,
    ).bind(now).run().catch(() => undefined);
    // Task #2: also emit one error_log row per swept job so the
    // existing failure-analytics/alerting (driven off error_log)
    // surfaces sweep-induced timeouts at the same fidelity as a
    // normal failed job.
    const swept_rows = await env.DB.prepare(
      `SELECT id FROM jobs WHERE status = 'timed_out' AND finished_at = ?`,
    ).bind(now).all<{ id: string }>();
    for (const row of swept_rows.results ?? []) {
      await logError(env, {
        err: new AppError({
          code: "workflow_step_failed",
          kind: "permanent",
          message: "job exceeded budget_ms; swept by admin.sweep",
          retryable: false,
          // `token` is the normalized analytics key (`workflow.step_failed`);
          // `code` stays in the closed ErrCode union (`workflow_step_failed`).
          context: {
            reason: "budget_exceeded",
            swept_by: "admin.sweep",
            token: "workflow.step_failed",
          },
        }),
        job_id: row.id,
        step: "admin.sweep",
      }).catch(() => undefined);
    }
  }
  return swept;
}

admin.post("/clear-stuck-jobs", async (c) => {
  // Task #2: `older_than_hours` may arrive via query string or JSON body
  // (incident response is often run from curl/dashboard with either).
  // Default behavior: budget-based sweep of `running` rows only.
  // With `older_than_hours`: also age-based sweep `running` rows to
  // `timed_out` AND cancel queued rows older than the cutoff.
  //
  // In-flight queue messages whose row was just swept are NOT acked
  // here — Cloudflare Queues doesn't expose a remote ack API. Instead,
  // the consumer self-short-circuits: `pipeline.isCancelled()` returns
  // true for both `cancelled` and `timed_out`, so the next status
  // check inside runJob returns immediately, and the queue catch-path
  // UPDATE is gated on `status IN ('queued','running')` so the final
  // ack cannot overwrite the swept terminal state. This gives the
  // equivalent of an ack-and-drop without needing direct purge.
  const body = (await c.req.json().catch(() => null)) as
    | { older_than_hours?: number }
    | null;
  const q = c.req.query("older_than_hours");
  const olderThan =
    (q ? Number(q) : undefined) ??
    (typeof body?.older_than_hours === "number" ? body.older_than_hours : undefined);

  const swept = await sweepStuckJobs(c.env);

  let runningTimedOut = 0;
  let queuedCancelled = 0;
  if (typeof olderThan === "number" && olderThan > 0) {
    const cutoffSec = Math.floor(olderThan * 3600);
    const now = new Date().toISOString();
    // Age-based running -> timed_out (independent of budget_ms).
    const r1 = await c.env.DB.prepare(
      `UPDATE jobs
          SET status = 'timed_out',
              finished_at = COALESCE(finished_at, ?),
              error = COALESCE(error, 'age_exceeded')
        WHERE status = 'running'
          AND running_started_at IS NOT NULL
          AND (strftime('%s', ?) - strftime('%s', running_started_at)) > ?`,
    ).bind(now, now, cutoffSec).run();
    runningTimedOut = Number(r1.meta?.changes ?? 0);
    // Age-based queued -> cancelled (one-time backlog drain). Allowed
    // by the migration-193 state machine. Note: queued rows go to
    // `cancelled` (not `timed_out`) because the migration-193 state
    // machine only permits `queued -> cancelled|running|dead_letter`.
    // `timed_out` is reserved for rows that actually began running.
    // Operators reading the dashboard should treat both as terminal
    // outcomes of the same sweep.
    const r2 = await c.env.DB.prepare(
      `UPDATE jobs
          SET status = 'cancelled',
              cancelled_at = ?,
              finished_at = COALESCE(finished_at, ?),
              error = COALESCE(error, 'queued_too_long')
        WHERE status = 'queued'
          AND (strftime('%s', ?) - strftime('%s', created_at)) > ?`,
    ).bind(now, now, now, cutoffSec).run();
    queuedCancelled = Number(r2.meta?.changes ?? 0);
  }

  return c.json({
    ok: true,
    swept,
    running_timed_out: runningTimedOut,
    queued_cancelled: queuedCancelled,
  });
});

admin.post("/rebuild-summary", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { entityId?: string; all?: boolean }
    | null;
  if (!body) return c.json({ error: "bad_request" }, 400);

  if (typeof body.entityId === "string" && body.entityId.length > 0) {
    await enqueueSummaryRebuild(c.env, body.entityId);
    return c.json({ ok: true, enqueued: 1 });
  }

  if (body.all === true) {
    let enqueued = 0;
    let lastId = "";
    // Page through active entities 200 at a time to avoid loading the
    // whole table into memory at once.
    while (true) {
      const rows = await c.env.DB.prepare(
        `SELECT id FROM u_entities
          WHERE status = 'active' AND id > ?
          ORDER BY id ASC LIMIT 200`,
      ).bind(lastId).all<{ id: string }>();
      const list = rows.results ?? [];
      if (!list.length) break;
      for (const r of list) {
        await enqueueSummaryRebuild(c.env, r.id);
        enqueued += 1;
      }
      lastId = list[list.length - 1].id;
      if (list.length < 200) break;
    }
    return c.json({ ok: true, enqueued });
  }

  return c.json({ error: "bad_request", message: "entityId or all=true required" }, 400);
});

admin.post("/repair-pipeline", async (c) => {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO repair_runs (id, started_at, status, triggered_by) VALUES (?, ?, 'running', ?)`,
  ).bind(runId, startedAt, c.var.email ?? "system").run();

  let stuckSwept = 0;
  let summariesEnq = 0;
  let rolesAdded = 0;
  let entitiesBackfilled = 0;
  // Task #2: structured per-phase failure list. Any non-empty list
  // flips the run to `failed` so a half-completed repair never reports
  // success to the operator.
  const phaseErrors: Array<{ phase: string; message: string }> = [];
  let errorMsg: string | null = null;

  try {
    // (1) sweep stuck running jobs.
    stuckSwept = await sweepStuckJobs(c.env);

    // (2) Backfill legacy-only records (leads/firms/companies/accounts/
    // buyers that have no `u_entities` row + `entity_legacy_map` entry
    // yet). The existing `backfillAll` helper is idempotent (uses
    // sync*ToEntity which upserts on the legacy key) and pages
    // 200/table/batch. A failure here is recorded as a phase error
    // and the overall run is marked failed.
    try {
      const progress = await backfillAll(c.env, { batches: 5 });
      for (const p of progress) entitiesBackfilled += p.synced;
    } catch (e) {
      phaseErrors.push({ phase: "backfill", message: (e as Error).message });
    }

    // (3) Re-enqueue summary rebuilds for any entity whose latest fact /
    // membership / fund-investment activity is newer than its
    // entity_summary.updated_at. Bounded to 500/run so a single call is
    // predictable.
    const stale = await c.env.DB.prepare(
      `SELECT e.id
         FROM u_entities e
         LEFT JOIN entity_summary s ON s.entity_id = e.id
        WHERE e.status = 'active'
          AND (s.updated_at IS NULL OR s.updated_at < e.updated_at)
        LIMIT 500`,
    ).all<{ id: string }>();
    for (const row of stale.results ?? []) {
      await enqueueSummaryRebuild(c.env, row.id);
      summariesEnq += 1;
    }

    // (4) Repair missing entity_roles for every legacy table. Each
    // statement is INSERT-OR-IGNORE on the (entity_id, role) unique
    // key so re-running the repair is a no-op once converged.
    //   leads  with investor_kind set → 'investor' role on the entity
    //   leads  without investor_kind  → 'prospect' role  (fallback)
    //   firms                          → 'firm'     role on the entity
    //   companies                      → 'company'  role on the entity
    const phases: Array<{ label: string; sql: string }> = [
      {
        label: "investor",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'investor', 1, 'repair', 1
                 FROM u_entities e
                 JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
                 JOIN leads l ON l.id = m.legacy_id
                WHERE e.kind = 'person'
                  AND l.investor_kind IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor')`,
      },
      {
        label: "prospect",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'prospect', 0, 'repair', 1
                 FROM u_entities e
                 JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
                WHERE e.kind = 'person'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
      },
      {
        label: "firm",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'firm', 1, 'repair', 1
                 FROM u_entities e
                 JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'firms'
                WHERE NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'firm')`,
      },
      {
        label: "company",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'company', 1, 'repair', 1
                 FROM u_entities e
                 JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'companies'
                WHERE NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'company')`,
      },
      // Modern-only entities (no entity_legacy_map row) still need a
      // role so they appear in /api/investors|companies|firms. Fall
      // back to inferring role from `u_entities.kind` for any entity
      // that ends the prior phases with zero roles.
      {
        label: "kind_fallback_person",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'prospect', 0, 'repair_kind_fallback', 0.5
                 FROM u_entities e
                WHERE e.kind = 'person'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
      },
      {
        label: "kind_fallback_firm",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'firm', 1, 'repair_kind_fallback', 0.5
                 FROM u_entities e
                WHERE e.kind = 'firm'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
      },
      {
        label: "kind_fallback_company",
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'company', 1, 'repair_kind_fallback', 0.5
                 FROM u_entities e
                WHERE e.kind = 'company'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
      },
    ];
    for (const p of phases) {
      try {
        const r = await c.env.DB.prepare(p.sql).run();
        rolesAdded += Number(r.meta?.changes ?? 0);
      } catch (e) {
        phaseErrors.push({ phase: `role:${p.label}`, message: (e as Error).message });
      }
    }
  } catch (e) {
    errorMsg = (e as Error).message;
  }

  const finishedAt = new Date().toISOString();
  // Roll any per-phase error into the run's status. Whether or not the
  // top-level try threw, a non-empty phaseErrors list means the run
  // did not fully converge and must be reported as failed.
  const combinedError =
    errorMsg ??
    (phaseErrors.length ? `phase_errors:${JSON.stringify(phaseErrors)}` : null);
  const failed = Boolean(combinedError);

  await c.env.DB.prepare(
    `UPDATE repair_runs
        SET finished_at = ?, status = ?, stuck_swept = ?, roles_added = ?, summaries_enq = ?, error = ?
      WHERE id = ?`,
  ).bind(
    finishedAt,
    failed ? "failed" : "succeeded",
    stuckSwept,
    rolesAdded,
    summariesEnq,
    combinedError,
    runId,
  ).run();

  return c.json({
    ok: !failed,
    run_id: runId,
    entities_backfilled: entitiesBackfilled,
    phase_errors: phaseErrors,
    stuck_swept: stuckSwept,
    roles_added: rolesAdded,
    summaries_enqueued: summariesEnq,
    error: combinedError,
  });
});

admin.get("/queue-health", async (c) => {
  const now = new Date().toISOString();
  const depth = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`,
  ).first<{ n: number }>();
  const running = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`,
  ).first<{ n: number }>();
  const stuck = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs
      WHERE status = 'running'
        AND running_started_at IS NOT NULL
        AND budget_ms IS NOT NULL
        AND (strftime('%s', ?) - strftime('%s', running_started_at)) * 1000 > budget_ms`,
  ).bind(now).first<{ n: number }>();
  const oldest = await c.env.DB.prepare(
    `SELECT MIN(running_started_at) AS s FROM jobs WHERE status = 'running' AND running_started_at IS NOT NULL`,
  ).first<{ s: string | null }>();
  const ageMs = oldest?.s
    ? (Date.parse(now) - Date.parse(oldest.s))
    : 0;

  // Task #2: p50/p95 age of currently-running jobs (in ms). SQLite has
  // no PERCENTILE_CONT, so we pull the age list and pick the indices.
  const ages = await c.env.DB.prepare(
    `SELECT (strftime('%s', ?) - strftime('%s', running_started_at)) * 1000 AS ms
       FROM jobs WHERE status = 'running' AND running_started_at IS NOT NULL
       ORDER BY ms ASC`,
  ).bind(now).all<{ ms: number }>();
  const ageList = (ages.results ?? []).map((r) => Number(r.ms ?? 0));
  // Nearest-rank percentile: index = ceil(p/100 * n) - 1, clamped to
  // [0, n-1]. This matches the standard nearest-rank definition and
  // avoids the small-sample skew from floor((p/100)*n).
  const pct = (p: number): number => {
    if (!ageList.length) return 0;
    const idx = Math.min(ageList.length - 1, Math.max(0, Math.ceil((p / 100) * ageList.length) - 1));
    return Math.max(0, ageList[idx] ?? 0);
  };

  // Top error_log step failures in the last 24h — operator-readable
  // rollup of which steps are misbehaving right now.
  const topFailures = await c.env.DB.prepare(
    `SELECT step, code, COUNT(*) AS n
       FROM error_log
      WHERE created_at >= datetime(?, '-1 day')
      GROUP BY step, code
      ORDER BY n DESC LIMIT 10`,
  ).bind(now).all<{ step: string; code: string; n: number }>().catch(() => null);

  // Summary-rebuild lag: entities whose entity_summary is stale.
  const rebuildLag = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM u_entities e
        LEFT JOIN entity_summary s ON s.entity_id = e.id
       WHERE e.status = 'active'
         AND (s.updated_at IS NULL OR s.updated_at < e.updated_at)`,
  ).first<{ n: number }>().catch(() => null);

  const lastRepair = await c.env.DB.prepare(
    `SELECT id, started_at, finished_at, status, stuck_swept, roles_added, summaries_enq
       FROM repair_runs ORDER BY started_at DESC LIMIT 1`,
  ).first();
  return c.json({
    depth: depth?.n ?? 0,
    running: running?.n ?? 0,
    stuck: stuck?.n ?? 0,
    oldest_running_age_ms: Math.max(0, ageMs),
    p50_running_age_ms: pct(50),
    p95_running_age_ms: pct(95),
    rebuild_lag: rebuildLag?.n ?? 0,
    top_failures_24h: topFailures?.results ?? [],
    last_repair: lastRepair ?? null,
  });
});
