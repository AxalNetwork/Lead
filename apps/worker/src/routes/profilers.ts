// Task #5: profiler routes (mounted at /api/profilers).
//
//   POST /api/profilers/:entity_id/run     — enqueue (returns workflow_run_id <200ms)
//   GET  /api/profilers/:entity_id/status  — per-enricher status + cost
//   GET  /api/profilers/:entity_id/dossier — denormalized read + to_do_business_with_them
//
// All endpoints sit behind the existing Cloudflare Access guard (mounted
// in index.ts via accessGuard).

import { Hono } from "hono";
import type { Env } from "../types";
import { checkRateLimit, clearLastRun, setLastRun } from "../services/profilers/rateLimit";
import { readDossier } from "../services/profilers/dossier";
import { runProfiler } from "../services/profilers/orchestrator";
import { computeWarmIntroPaths } from "../services/profilers/synthesize";

export const profilers = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// Allowlisted operator emails (force_refresh is operator-only).
const OPERATOR_EMAILS = new Set<string>(["guillaumelauzier@gmail.com"]);

profilers.post("/:entity_id/run", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);

  const url = new URL(c.req.url);
  const forceRefresh = url.searchParams.get("force_refresh") === "true";
  const viewerEntityId = url.searchParams.get("viewer_entity_id") || null;
  const triggeredBy = c.var.email || "unknown";

  if (forceRefresh && !OPERATOR_EMAILS.has(triggeredBy.toLowerCase())) {
    return c.json({ error: "operator_only", message: "force_refresh requires operator role" }, 403);
  }

  // 7-day rate limit.
  const rl = await checkRateLimit(c.env, entityId, { forceRefresh });
  if (!rl.allowed) {
    return c.json({
      error: "rate_limited",
      message: "1 profiler run per entity per 7 days; pass ?force_refresh=true (operator) to bypass",
      next_eligible_at: rl.nextEligibleAt,
      last_run_id: rl.lastRunId,
    }, 429);
  }

  // force_refresh audit log entry (best-effort — pii_audit_log may not
  // exist in all environments).
  if (forceRefresh) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO pii_audit_log (id, entity_id, actor_email, action, observed_at, request_id, notes)
           VALUES (?, ?, ?, 'profiler_force_refresh', datetime('now'), ?, NULL)`,
      ).bind(crypto.randomUUID(), entityId, triggeredBy, c.req.header("cf-ray") ?? "").run();
    } catch { /* table may not exist */ }
  }

  const runId = crypto.randomUUID();
  await setLastRun(c.env, entityId, { runId, startedAt: new Date().toISOString() });

  // Try the Workflow binding first; fall back to inline ctx.waitUntil if
  // the binding isn't configured (dev / test). Either way the route
  // returns <200 ms because the actual work is deferred.
  //
  // IMPORTANT — rate-limit recovery: the orchestrator clears the KV
  // last-run key on pre-run failure (entity not found, wrong kind). If
  // the Workflow dispatch itself throws synchronously we must do the
  // same here so the entity isn't locked out for 7 days by a
  // never-started run.
  let workflowRunId: string | null = null;
  const wf = (c.env as Env & { WF_PROFILER_INDIVIDUAL?: { create: (opts: { params: unknown }) => Promise<{ id: string }> } }).WF_PROFILER_INDIVIDUAL;
  if (wf && typeof wf.create === "function") {
    try {
      const inst = await wf.create({ params: { entityId, runId, triggeredBy, forceRefresh, viewerEntityId } });
      workflowRunId = inst.id;
      await c.env.DB.prepare(`UPDATE profiler_runs SET workflow_run_id = ? WHERE id = ?`).bind(workflowRunId, runId).run().catch(() => undefined);
    } catch (e) {
      console.warn("profilers: workflow dispatch failed, falling back to waitUntil", (e as Error).message);
    }
  }
  if (!workflowRunId) {
    c.executionCtx.waitUntil(
      runProfiler(c.env, entityId, { runId, triggeredBy, forceRefresh, viewerEntityId })
        .catch(async (e) => {
          console.warn("profilers: inline run failed", entityId, (e as Error).message);
          // Best-effort lockout recovery for failures that the
          // orchestrator didn't itself recover from.
          await clearLastRun(c.env, entityId);
        }),
    );
  }

  return c.json({
    ok: true, run_id: runId, workflow_run_id: workflowRunId,
    entity_id: entityId, queued_at: new Date().toISOString(),
  }, 202);
});

profilers.get("/:entity_id/status", async (c) => {
  const entityId = c.req.param("entity_id");
  const runRes = await c.env.DB.prepare(
    `SELECT id, status, triggered_by, force_refresh, respects_privacy,
            privacy_reasons_json, enricher_count, writes_count, failed_count,
            skipped_count, total_neurons, total_est_usd, total_wall_ms,
            started_at, finished_at, workflow_run_id
       FROM profiler_runs WHERE entity_id = ?
       ORDER BY started_at DESC LIMIT 1`,
  ).bind(entityId).first<{ id: string; status: string; triggered_by: string; force_refresh: number;
    respects_privacy: number; privacy_reasons_json: string | null; enricher_count: number;
    writes_count: number; failed_count: number; skipped_count: number; total_neurons: number;
    total_est_usd: number; total_wall_ms: number; started_at: string; finished_at: string | null;
    workflow_run_id: string | null }>();

  if (!runRes) return c.json({ entity_id: entityId, status: "no_runs", enrichers: [] });

  const logs = await c.env.DB.prepare(
    `SELECT enricher_name, category, status, skipped_reason, error, writes_count,
            neurons, fetches, bytes, wall_ms, est_usd, started_at, finished_at
       FROM profiler_enricher_logs WHERE run_id = ?
       ORDER BY enricher_name ASC`,
  ).bind(runRes.id).all();

  return c.json({
    entity_id: entityId,
    run: {
      id: runRes.id, workflow_run_id: runRes.workflow_run_id,
      status: runRes.status, triggered_by: runRes.triggered_by,
      force_refresh: runRes.force_refresh === 1,
      respects_privacy: runRes.respects_privacy === 1,
      privacy_reasons: JSON.parse(runRes.privacy_reasons_json || "[]") as string[],
      enricher_count: runRes.enricher_count,
      writes_count: runRes.writes_count,
      failed_count: runRes.failed_count,
      skipped_count: runRes.skipped_count,
      totals: {
        neurons: runRes.total_neurons,
        est_usd: runRes.total_est_usd,
        wall_ms: runRes.total_wall_ms,
      },
      started_at: runRes.started_at,
      finished_at: runRes.finished_at,
    },
    enrichers: logs.results ?? [],
  });
});

profilers.get("/:entity_id/dossier", async (c) => {
  const entityId = c.req.param("entity_id");
  const noCache = c.req.query("no_cache") === "true";
  const viewerEntityId = c.req.query("viewer_entity_id") || null;
  // Per-viewer cache: viewer-specific warm-intro paths must NOT bleed
  // across callers, so the cache key includes the viewer when present.
  const bundle = await readDossier(c.env, entityId, { noCache, viewerEntityId });

  // Viewer-specific 2-hop BFS, computed at read time and merged onto
  // the bundle without mutating persisted synthesis.
  if (viewerEntityId && bundle.latest_synthesis) {
    const viewerPaths = await computeWarmIntroPaths(c.env, entityId, viewerEntityId);
    if (viewerPaths.length > 0) {
      const synth = bundle.latest_synthesis;
      const tdb = synth.to_do_business_with_them as { warm_intro_paths?: unknown };
      tdb.warm_intro_paths = viewerPaths;
      synth.warm_intro_paths_count = viewerPaths.length;
    }
  }
  return c.json(bundle);
});
