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
  const nowMs = Date.parse(now);
  // Task #7: per-pipeline budget overrides. We can no longer do the
  // sweep as a single UPDATE because `effective_budget = max(
  // jobs.budget_ms, PIPELINE_BUDGETS_MS[kind])` lives in JS, not SQL.
  // Pattern: SELECT candidates → filter in JS → UPDATE qualifying ids
  // → attribute step from each job's last workflow_step_log row →
  // logError per swept job. Candidate set is small (running rows
  // only), so the extra round-trip is cheap.
  const { effectiveBudgetMs } = await import("../queue/pipelineBudgets.js");
  const candidates = await env.DB.prepare(
    // NOTE: we deliberately do NOT filter `budget_ms IS NOT NULL`
    // here — null-budget legacy rows still get the default + any
    // per-pipeline override applied by `effectiveBudgetMs`.
    `SELECT id, kind, budget_ms, running_started_at
       FROM jobs
      WHERE status = 'running'
        AND running_started_at IS NOT NULL
      ORDER BY running_started_at ASC
      LIMIT 200`,
  ).all<{ id: string; kind: string | null; budget_ms: number | null; running_started_at: string }>();
  const overdue: Array<{ id: string; kind: string | null }> = [];
  for (const row of candidates.results ?? []) {
    const startedMs = Date.parse(row.running_started_at);
    if (!Number.isFinite(startedMs)) continue;
    const elapsedMs = nowMs - startedMs;
    const budget = effectiveBudgetMs(row.budget_ms, row.kind);
    if (elapsedMs > budget) overdue.push({ id: row.id, kind: row.kind });
  }
  let swept = 0;
  for (const job of overdue) {
    const u = await env.DB.prepare(
      `UPDATE jobs
          SET status = 'timed_out',
              finished_at = ?,
              error = COALESCE(error, 'budget_exceeded')
        WHERE id = ? AND status = 'running'`,
    ).bind(now, job.id).run();
    if (Number(u.meta?.changes ?? 0) === 0) continue; // raced with another writer
    swept += 1;

    // Task #2: state-transition row for /api/jobs/:id history.
    await env.DB.prepare(
      `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by)
       VALUES (?, 'running', 'timed_out', 'budget_exceeded', 'admin.sweep')`,
    ).bind(job.id).run().catch(() => undefined);

    // Task #7: attribute the step that owned the deadline at sweep
    // time. We read the LAST row in workflow_step_log for this job
    // (latest by id; rows are append-only so id ASC = chronological).
    // Prefer a still-running step (`status='started'`) when present —
    // that's the actual heartbeat the deadline interrupted. Falls
    // back to whatever the latest row is. When no heartbeat row
    // exists (legacy/early job) the step field stays as the static
    // `admin.sweep` sentinel so the UI never renders an empty cell.
    let lastStep: string | null = null;
    try {
      const startedRow = await env.DB.prepare(
        `SELECT step FROM workflow_step_log
          WHERE job_id = ? AND status = 'started'
          ORDER BY id DESC LIMIT 1`,
      ).bind(job.id).first<{ step: string | null }>();
      if (startedRow?.step) {
        lastStep = startedRow.step;
      } else {
        const anyRow = await env.DB.prepare(
          `SELECT step FROM workflow_step_log
            WHERE job_id = ?
            ORDER BY id DESC LIMIT 1`,
        ).bind(job.id).first<{ step: string | null }>();
        lastStep = anyRow?.step ?? null;
      }
    } catch { /* workflow_step_log absent in fresh env — fall through */ }

    // Task #2: error_log row so analytics/alerts count sweep-induced
    // timeouts at the same fidelity as a normal failed job. The
    // `step` field now carries the heartbeat step (Task #7), not
    // just `admin.sweep`.
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
          pipeline_kind: job.kind ?? null,
          heartbeat_step: lastStep,
        },
      }),
      job_id: job.id,
      step: lastStep ?? "admin.sweep",
    }).catch(() => undefined);
  }

  // Task #7: also write workflow_step_failed rows for jobs that were
  // already transitioned to `timed_out` by the in-run deadline path
  // in scraper/pipeline.ts. That path no longer writes its own
  // error_log row (architectural constraint: sweeper is the SOLE
  // writer of workflow_step_failed). Look back 24h for timed_out jobs
  // with no existing workflow_step_failed row and write one each.
  try {
    const orphans = await env.DB.prepare(
      `SELECT j.id, j.kind FROM jobs j
        WHERE j.status = 'timed_out'
          AND j.finished_at >= datetime('now', '-1 day')
          AND NOT EXISTS (
            SELECT 1 FROM error_log e
             WHERE e.job_id = j.id AND e.code = 'workflow_step_failed'
          )
        LIMIT 200`,
    ).all<{ id: string; kind: string | null }>();
    for (const job of orphans.results ?? []) {
      let lastStep: string | null = null;
      try {
        const r = await env.DB.prepare(
          `SELECT step FROM workflow_step_log WHERE job_id = ?
            ORDER BY id DESC LIMIT 1`,
        ).bind(job.id).first<{ step: string | null }>();
        lastStep = r?.step ?? null;
      } catch { /* missing table — fall through */ }
      await logError(env, {
        err: new AppError({
          code: "workflow_step_failed",
          kind: "permanent",
          message: "job exceeded budget_ms; in-run deadline fired",
          retryable: false,
          context: {
            reason: "budget_exceeded",
            swept_by: "admin.sweep",
            source: "in_run_deadline",
            token: "workflow.step_failed",
            pipeline_kind: job.kind ?? null,
            heartbeat_step: lastStep,
          },
        }),
        job_id: job.id,
        step: lastStep ?? "pipeline.deadline",
      }).catch(() => undefined);
    }
  } catch { /* error_log/jobs absent in fresh env — fall through */ }

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
    //
    // RUNBOOK: This is intentional divergence from the spec's
    // "ack-and-drop everything" phrasing. Cloudflare Queues offers no
    // remote-ack API, so we instead rely on (a) the state-machine
    // transition above making the row terminal, and (b) the queue
    // consumer's `pipeline.isCancelled()` returning true for both
    // `cancelled` and `timed_out` so a delayed delivery short-circuits
    // immediately and acks. End result is equivalent to ack-and-drop
    // for operators: no further side-effects, no further retries.
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
      // Task #2: loop backfillAll to completion (until every table
      // returns next_offset:null) rather than capping at 5 batches.
      // Each batch is 200 rows/table, so a full pass over a large
      // dataset is bounded but predictable. We cap the outer iteration
      // at 50 (=10k rows/table) per request to keep a single
      // /repair-pipeline call within Workers CPU budget; operators can
      // re-invoke until backfill_remaining == 0 in /queue-health.
      const maxLoops = 50;
      for (let loop = 0; loop < maxLoops; loop++) {
        const progress = await backfillAll(c.env, { batches: 1 });
        let any = false;
        for (const p of progress) {
          entitiesBackfilled += p.synced;
          if (p.next_offset != null && p.scanned > 0) any = true;
        }
        if (!any) break;
      }
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
      // role so they appear in /api/investors|companies|firms. The
      // u_entities.kind taxonomy is only person|org, so role here is
      // inferred from heuristics rather than directly from kind:
      //   - person + VC-flavored legacy persona_role / leads.role  -> investor
      //   - person + any legacy mapping at all                     -> prospect
      //   - person otherwise                                       -> prospect
      //   - org    + legacy firms row                              -> firm (covered above)
      //   - org    + legacy companies row                          -> company (covered above)
      //   - org    + legacy investor-flavored persona              -> firm
      //   - org    otherwise                                       -> company
      // Confidence is 0.5 so future explicit signals (extractor,
      // operator UI) can promote without conflict.
      {
        label: "kind_fallback_person_investor",
        // Promote person -> investor when legacy lead row exposes a
        // VC-flavored persona_role / role / current_role_title.
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'investor', 1, 'repair_kind_fallback_persona', 0.5
                 FROM u_entities e
                 JOIN entity_legacy_map m
                   ON m.entity_id = e.id AND m.legacy_table = 'leads'
                 JOIN leads l ON l.id = m.legacy_id
                WHERE e.kind = 'person'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)
                  AND (
                    l.persona_role IN ('vc_partner','vc_principal','vc_analyst','operating_partner')
                 OR LOWER(COALESCE(l.role,'')) LIKE '%partner%'
                 OR LOWER(COALESCE(l.role,'')) LIKE '%investor%'
                 OR LOWER(COALESCE(l.role,'')) LIKE '%principal%'
                 OR LOWER(COALESCE(l.current_role_title,'')) LIKE '%partner%'
                 OR LOWER(COALESCE(l.current_role_title,'')) LIKE '%investor%'
                  )`,
      },
      {
        label: "kind_fallback_person_prospect",
        // Remaining role-less persons -> prospect (low confidence).
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'prospect', 0, 'repair_kind_fallback', 0.5
                 FROM u_entities e
                WHERE e.kind = 'person'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
      },
      {
        label: "kind_fallback_org_firm",
        // Org whose primary_domain matches a legacy firm row -> firm.
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'firm', 1, 'repair_kind_fallback_persona', 0.5
                 FROM u_entities e
                WHERE e.kind = 'org'
                  AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)
                  AND EXISTS (
                    SELECT 1 FROM firms f
                     WHERE LOWER(COALESCE(f.domain,'')) = LOWER(COALESCE(e.primary_domain,''))
                       AND e.primary_domain IS NOT NULL
                  )`,
      },
      {
        label: "kind_fallback_org_company",
        // Remaining role-less orgs -> company.
        sql: `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
               SELECT e.id, 'company', 1, 'repair_kind_fallback', 0.5
                 FROM u_entities e
                WHERE e.kind = 'org'
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

  // Task #2: backfill / repair residual drift — exposes how many
  // legacy rows still lack a u_entities mapping, plus how many active
  // entities still lack any entity_roles row. Operators run
  // /api/admin/repair-pipeline until both reach 0. Cheap COUNT
  // queries against legacy tables left-joined to entity_legacy_map.
  const backfillRemaining = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM firms     f LEFT JOIN entity_legacy_map m ON m.legacy_table='firms'     AND m.legacy_id=f.id WHERE m.entity_id IS NULL) AS firms_missing,
       (SELECT COUNT(*) FROM companies c LEFT JOIN entity_legacy_map m ON m.legacy_table='companies' AND m.legacy_id=c.id WHERE m.entity_id IS NULL) AS companies_missing,
       (SELECT COUNT(*) FROM leads     l LEFT JOIN entity_legacy_map m ON m.legacy_table='leads'     AND m.legacy_id=l.id WHERE m.entity_id IS NULL) AS leads_missing`,
  ).first<{ firms_missing: number; companies_missing: number; leads_missing: number }>().catch(() => null);
  const rolesRemaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM u_entities e
      WHERE e.status='active'
        AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
  ).first<{ n: number }>().catch(() => null);

  // Task #2: over-budget alarm. Counts running rows that have been
  // over their budget for >90s; an operational invariant — should
  // always be 0 thanks to in-run deadline + batch-head + hourly
  // sweep. Non-zero indicates one of the sweep paths is failing.
  const overBudgetGraceSec = 90;
  const overBudget = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs
      WHERE status = 'running'
        AND running_started_at IS NOT NULL
        AND budget_ms IS NOT NULL
        AND ((strftime('%s', ?) - strftime('%s', running_started_at)) * 1000 - budget_ms) > ?`,
  ).bind(now, overBudgetGraceSec * 1000).first<{ n: number }>().catch(() => null);

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
    // alarm: invariant — should always be 0; non-zero means a sweep
    // path is failing and operators should investigate immediately.
    over_budget_alarm: overBudget?.n ?? 0,
    over_budget_grace_sec: overBudgetGraceSec,
    // Task #2: residual drift counters. Should converge to 0 after
    // /api/admin/repair-pipeline finishes. Non-zero on a fresh repair
    // run = re-invoke (or dataset is huge; check repair_runs.synced).
    backfill_remaining: {
      firms: backfillRemaining?.firms_missing ?? 0,
      companies: backfillRemaining?.companies_missing ?? 0,
      leads: backfillRemaining?.leads_missing ?? 0,
    },
    roles_remaining: rolesRemaining?.n ?? 0,
    last_repair: lastRepair ?? null,
  });
});

// ---------------------------------------------------------------------------
// Task #6 (Comprehensive Bug Sweep) — Sections A, B, D.
//
// Operator-triggered bulk maintenance endpoints. Gated by the existing
// accessGuard (email allowlist) — admin gating happens at the
// /api/ops/* prefix; /api/admin/* is operator-only but not strictly
// admin-only. Section N's Quality Console buttons POST here.
// ---------------------------------------------------------------------------

import { runCleanupSweep } from "../entities/garbage";
import { isBadEntityName, displayFromDomain } from "../entities/badName";

// Section A: garbage entity sweep. Soft-deletes (never hard DELETE)
// every active entity matching the heuristic detector. Returns before/
// after counts so the operator console can show the diff.
admin.post("/garbage-sweep", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { mode?: "recent" | "all"; limit?: number; skipAi?: boolean }
    | null;
  // Default to "all" (full pass) per the Section A spec; honor an
  // explicit "recent" for operator-triggered incremental sweeps.
  const mode: "recent" | "all" = body?.mode === "recent" ? "recent" : "all";
  const limit = typeof body?.limit === "number" ? Math.min(Math.max(body.limit, 1), 10000) : 5000;
  const skipAi = body?.skipAi !== false; // skip AI by default; operator can flip

  const beforeRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM u_entities WHERE status = 'active'`,
  ).first<{ n: number }>().catch(() => null);

  const result = await runCleanupSweep(c.env, {
    mode, limit, skipAi,
    source: "admin.garbage_sweep",
    actorEmail: c.var.email ?? null,
  });

  const afterRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM u_entities WHERE status = 'active'`,
  ).first<{ n: number }>().catch(() => null);

  return c.json({
    ok: true,
    active_before: beforeRow?.n ?? null,
    active_after: afterRow?.n ?? null,
    delta: (beforeRow?.n ?? 0) - (afterRow?.n ?? 0),
    ...result,
  });
});

// Section B: CSV column-mapping bug. Re-derives `display_name` from
// `primary_domain` / `primary_url` for every active entity whose name
// is a kind-string like "VC" / "Nonprofit" / "Training Program" (per
// the isBadEntityName predicate). Wrapped in a single bulk UPDATE
// per-entity so the audit trail in entity_history records each fix.
admin.post("/csv-name-remap", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { limit?: number; dryRun?: boolean; cursor?: string }
    | null;
  const limit = Math.min(Math.max(body?.limit ?? 2000, 1), 10000);
  const dryRun = body?.dryRun === true;

  // Deterministic, convergent pagination: scan in ID-ASC order from
  // the optional cursor; each call returns next_cursor so a repeated
  // operator click walks the whole table without re-hitting the same
  // rows or skipping any. The page size (`limit`) bounds per-call CPU.
  const cursor = typeof body?.cursor === "string" ? body!.cursor : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, display_name, primary_url, primary_domain
       FROM u_entities
      WHERE status = 'active' AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
  ).bind(cursor, limit).all<{ id: string; display_name: string | null; primary_url: string | null; primary_domain: string | null }>();

  const items = rows.results ?? [];
  let scanned = 0, fixed = 0, no_domain = 0, skipped_noop = 0;
  const examples: Array<{ id: string; from: string | null; to: string }> = [];
  const now = new Date().toISOString();

  for (const r of items) {
    scanned += 1;
    if (!isBadEntityName(r.display_name)) continue;
    const derived = displayFromDomain(r.primary_url ?? r.primary_domain);
    if (!derived) { no_domain += 1; continue; }
    // Skip when the derived value matches what's already stored — keeps
    // entity_history clean and avoids touching updated_at unnecessarily.
    if (derived === (r.display_name ?? "")) { skipped_noop += 1; continue; }
    if (examples.length < 25) examples.push({ id: r.id, from: r.display_name, to: derived });
    if (dryRun) { fixed += 1; continue; }
    try {
      await c.env.DB.prepare(
        `UPDATE u_entities SET display_name = ?, updated_at = ? WHERE id = ?`,
      ).bind(derived, now, r.id).run();
      try {
        await c.env.DB.prepare(
          `INSERT INTO entity_history (id, entity_id, action, source, changed_at, old_value, new_value)
           VALUES (?, ?, 'name_remap', 'admin.csv_name_remap', ?, ?, ?)`,
        ).bind(crypto.randomUUID(), r.id, now, r.display_name ?? "", derived).run();
      } catch { /* entity_history schema variants — best-effort audit */ }
      fixed += 1;
    } catch (e) {
      console.warn("csv-name-remap update failed", r.id, (e as Error).message);
    }
  }

  const next_cursor = items.length === limit ? items[items.length - 1].id : null;
  return c.json({ ok: true, dry_run: dryRun, scanned, fixed, no_domain, skipped_noop, next_cursor, examples });
});

// Section D: stuck CSV import sweep. Forces csv_imports rows with
// status='running' AND no heartbeat in 5+ min (or NULL) to 'timed_out',
// and force-cancels long-running csv_import jobs (the queue-side
// envelope) older than 30 minutes.
admin.post("/sweep-csv-imports", async (c) => {
  const now = new Date().toISOString();
  let importsTimedOut = 0;
  let jobsCancelled = 0;

  // csv_imports table — the workflow uses updated_at as its heartbeat.
  try {
    const r = await c.env.DB.prepare(
      `UPDATE csv_imports
          SET status = 'timed_out',
              updated_at = ?,
              error_log_json = COALESCE(error_log_json, '{"reason":"heartbeat_stale_>5min"}')
        WHERE status = 'running'
          AND (updated_at IS NULL
               OR (strftime('%s', ?) - strftime('%s', updated_at)) > 300)`,
    ).bind(now, now).run();
    importsTimedOut = Number(r.meta?.changes ?? 0);
  } catch (e) {
    console.warn("sweep-csv-imports: csv_imports update failed", (e as Error).message);
  }

  // csv_import envelope jobs — long-running > 30 min go to cancelled.
  try {
    const r = await c.env.DB.prepare(
      `UPDATE jobs
          SET status = 'cancelled',
              cancelled_at = ?,
              finished_at = COALESCE(finished_at, ?),
              error = COALESCE(error, 'csv_import_long_running')
        WHERE kind = 'csv_import'
          AND status = 'running'
          AND running_started_at IS NOT NULL
          AND (strftime('%s', ?) - strftime('%s', running_started_at)) > 1800`,
    ).bind(now, now, now).run();
    jobsCancelled = Number(r.meta?.changes ?? 0);
  } catch (e) {
    console.warn("sweep-csv-imports: jobs update failed", (e as Error).message);
  }

  return c.json({ ok: true, imports_timed_out: importsTimedOut, jobs_cancelled: jobsCancelled });
});

// Task #7: identity backfill — promote scraped social/website facts into
// identity_handles for persons missing them. Bounded by `limit` (≤500).
// `osint=0` skips the username-enumeration pass for a faster, cheaper run.
admin.post("/backfill-identity", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { limit?: number; osint?: boolean }
    | null;
  const limitRaw = Number(c.req.query("limit") ?? body?.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
  const runOsint = body?.osint !== false && c.req.query("osint") !== "0";
  const { runIdentityBackfill } = await import("../services/identity/backfill.js");
  const result = await runIdentityBackfill(c.env, { limit, runOsint });
  return c.json({ ok: true, ...result });
});
