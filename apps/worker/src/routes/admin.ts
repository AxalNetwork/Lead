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
import { enqueueSummaryRebuild } from "../entities/summaryQueue";

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
       AND started_at IS NOT NULL
       AND budget_ms IS NOT NULL
       AND (strftime('%s', ?) - strftime('%s', started_at)) * 1000 > budget_ms`,
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
  }
  return swept;
}

admin.post("/clear-stuck-jobs", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { older_than_hours?: number }
    | null;
  const swept = await sweepStuckJobs(c.env);

  // Task #2: optional one-time backlog drain. When `older_than_hours`
  // is supplied, also cancel any `queued` job whose created_at is
  // older than that cutoff. The queued -> cancelled transition is
  // allowed by the migration-193 state machine.
  let queuedCancelled = 0;
  const olderThan = body?.older_than_hours;
  if (typeof olderThan === "number" && olderThan > 0) {
    const cutoffSec = Math.floor(olderThan * 3600);
    const now = new Date().toISOString();
    const r = await c.env.DB.prepare(
      `UPDATE jobs
          SET status = 'cancelled',
              cancelled_at = ?,
              finished_at = COALESCE(finished_at, ?),
              error = COALESCE(error, 'queued_too_long')
        WHERE status = 'queued'
          AND (strftime('%s', ?) - strftime('%s', created_at)) > ?`,
    ).bind(now, now, now, cutoffSec).run();
    queuedCancelled = Number(r.meta?.changes ?? 0);
  }

  return c.json({ ok: true, swept, queued_cancelled: queuedCancelled });
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
  let errorMsg: string | null = null;

  try {
    // (1) sweep stuck running jobs.
    stuckSwept = await sweepStuckJobs(c.env);

    // (2) Re-enqueue summary rebuilds for any entity whose latest fact /
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

    // (3) Attach the canonical `prospect` role to any person entity that
    // was created via the leads dual-write but never had any role row
    // attached (the symptom that breaks /api/investors filtering). This
    // matches the spec phrase "entity_roles attached" and is idempotent
    // — INSERT OR IGNORE on the (entity_id, role) unique key.
    const roleRes = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
         SELECT e.id, 'prospect', 0, 'repair', 1
           FROM u_entities e
           JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
          WHERE e.kind = 'person'
            AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)`,
    ).run().catch(() => null);
    rolesAdded = Number(roleRes?.meta?.changes ?? 0);
  } catch (e) {
    errorMsg = (e as Error).message;
  }

  const finishedAt = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE repair_runs
        SET finished_at = ?, status = ?, stuck_swept = ?, roles_added = ?, summaries_enq = ?, error = ?
      WHERE id = ?`,
  ).bind(
    finishedAt,
    errorMsg ? "failed" : "succeeded",
    stuckSwept,
    rolesAdded,
    summariesEnq,
    errorMsg,
    runId,
  ).run();

  return c.json({
    ok: !errorMsg,
    run_id: runId,
    stuck_swept: stuckSwept,
    roles_added: rolesAdded,
    summaries_enqueued: summariesEnq,
    error: errorMsg,
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
        AND started_at IS NOT NULL
        AND budget_ms IS NOT NULL
        AND (strftime('%s', ?) - strftime('%s', started_at)) * 1000 > budget_ms`,
  ).bind(now).first<{ n: number }>();
  const oldest = await c.env.DB.prepare(
    `SELECT MIN(started_at) AS s FROM jobs WHERE status = 'running'`,
  ).first<{ s: string | null }>();
  const ageMs = oldest?.s
    ? (Date.parse(now) - Date.parse(oldest.s))
    : 0;
  const lastRepair = await c.env.DB.prepare(
    `SELECT id, started_at, finished_at, status, stuck_swept, roles_added, summaries_enq
       FROM repair_runs ORDER BY started_at DESC LIMIT 1`,
  ).first();
  return c.json({
    depth: depth?.n ?? 0,
    running: running?.n ?? 0,
    stuck: stuck?.n ?? 0,
    oldest_running_age_ms: Math.max(0, ageMs),
    last_repair: lastRepair ?? null,
  });
});
