// Task #6 (Comprehensive Bug Sweep) — Section N: Quality Console rollup.
//
//   GET /api/ops/quality/rollup
//
// Mounted under /api/ops/* so the existing adminOnly middleware in
// src/index.ts gates the route (no parallel gate needed — see the
// Task #14 inline-admin pattern in replit.md).
//
// All sub-queries wrapped in safeCount() so a missing optional table
// (e.g. data_quality_log on a fresh DB) degrades to 0 with the slice
// key appended to `missing_subsystems` — same honest-degradation
// pattern as routes/profile.ts.

import { Hono } from "hono";
import type { Env } from "../types";

export const opsQualityRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

async function safeCount(env: Env, sql: string, binds: unknown[], tracker: string[], slice: string): Promise<number> {
  try {
    const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch (e) {
    console.warn(`ops_quality slice "${slice}" failed:`, (e as Error).message);
    tracker.push(slice);
    return 0;
  }
}

opsQualityRoute.get("/rollup", async (c) => {
  const missing: string[] = [];
  const [
    garbageCleanedToday,
    csvImportsWithErrors,
    lockedOverrides,
    contradictingFacts,
    dedupeBacklog,
    softDeletedThisWeek,
    stuckRunningJobs,
    activeEntities,
  ] = await Promise.all([
    // Garbage entities soft-deleted today via data_quality_log.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM data_quality_log
        WHERE issue = 'soft_deleted'
          AND created_at >= datetime('now', '-1 day')`,
      [], missing, "garbage_cleaned_today",
    ),
    // CSV imports that errored or need manual mapping.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM csv_imports
        WHERE status IN ('failed','needs_manual_mapping','timed_out')`,
      [], missing, "csv_imports_with_errors",
    ),
    // Operator-locked field overrides (Task #3 migration 376).
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM field_overrides
        WHERE locked = 1 AND status = 'active'`,
      [], missing, "locked_overrides",
    ),
    // Contradicting facts: same (entity_id, predicate) with multiple
    // is_current=1 rows from distinct sources.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM (
         SELECT entity_id, predicate
           FROM facts
          WHERE is_current = 1
          GROUP BY entity_id, predicate
         HAVING COUNT(DISTINCT source) > 1
       )`,
      [], missing, "contradicting_facts",
    ),
    // Dedupe review backlog: cross-ref candidates awaiting operator
    // verdict. Table name varies by migration; try the canonical one.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM cross_ref_candidates
        WHERE status = 'pending'`,
      [], missing, "dedupe_backlog",
    ),
    // Anything soft-deleted (any reason) in the last 7 days.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM u_entities
        WHERE status = 'soft_deleted'
          AND updated_at >= datetime('now', '-7 days')`,
      [], missing, "soft_deleted_this_week",
    ),
    // Stuck/running jobs — operator-visible signal that the queue is healthy.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`,
      [], missing, "stuck_running_jobs",
    ),
    // Active entity total — denominator for ratios in the UI.
    safeCount(
      c.env,
      `SELECT COUNT(*) AS n FROM u_entities WHERE status = 'active'`,
      [], missing, "active_entities",
    ),
  ]);

  return c.json({
    as_of: new Date().toISOString(),
    counts: {
      garbage_cleaned_today: garbageCleanedToday,
      csv_imports_with_errors: csvImportsWithErrors,
      locked_overrides: lockedOverrides,
      contradicting_facts: contradictingFacts,
      dedupe_backlog: dedupeBacklog,
      soft_deleted_this_week: softDeletedThisWeek,
      stuck_running_jobs: stuckRunningJobs,
      active_entities: activeEntities,
    },
    drilldowns: {
      garbage_cleaned_today: "/dashboard/ops-garbage-review/",
      csv_imports_with_errors: "/dashboard/imports/",
      locked_overrides: "/api/overrides/locked",
      contradicting_facts: "/api/facts/contradictions",
      dedupe_backlog: "/dashboard/review/",
      soft_deleted_this_week: "/dashboard/ops-garbage-review/",
      stuck_running_jobs: "/dashboard/jobs/",
    },
    missing_subsystems: missing,
  });
});

// Recent soft-delete audit feed — surfaced on the console for at-a-glance triage.
opsQualityRoute.get("/recent-soft-deletes", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "25"), 1), 200);
  try {
    const rows = await c.env.DB.prepare(
      `SELECT q.entity_id, q.reasons_json, q.source, q.actor_email, q.created_at,
              u.display_name, u.kind, u.primary_domain
         FROM data_quality_log q
         LEFT JOIN u_entities u ON u.id = q.entity_id
        WHERE q.issue = 'soft_deleted'
        ORDER BY q.created_at DESC
        LIMIT ?`,
    ).bind(limit).all<Record<string, unknown>>();
    const items = (rows.results ?? []).map((r) => {
      let reasons: unknown = r.reasons_json;
      try { reasons = JSON.parse(String(r.reasons_json ?? "[]")); } catch { /* leave as-is */ }
      return { ...r, reasons };
    });
    return c.json({ items });
  } catch (e) {
    return c.json({ items: [], error: (e as Error).message }, 200);
  }
});
