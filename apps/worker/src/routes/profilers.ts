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

// Operator gate: this worker is single-tenant — exactly one Access
// identity (env.ALLOWED_EMAIL, enforced by accessGuard) reaches these
// routes. The "operator" role is therefore equivalent to the
// authenticated caller matching env.ALLOWED_EMAIL. We compare here too
// (instead of trusting the guard alone) so force_refresh is explicit
// in code and audit-grep-able.
function isOperator(c: { env: Env; var: { email: string } }): boolean {
  const email = (c.var.email || "").toLowerCase();
  const allowed = (c.env.ALLOWED_EMAIL || "").toLowerCase();
  return Boolean(email) && email === allowed;
}

// Resolve the caller's viewer entity from their authenticated email,
// not from a user-controlled query param. Returns null if the caller
// has no entity row yet (treated as "no warm-intro paths available").
async function resolveCallerViewerEntity(c: { env: Env; var: { email: string } }): Promise<string | null> {
  const email = (c.var.email || "").toLowerCase();
  if (!email) return null;
  try {
    const row = await c.env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE kind = 'person' AND lower(primary_email_key) = ?
          AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(email).first<{ id: string }>();
    return row?.id ?? null;
  } catch { return null; }
}

profilers.post("/:entity_id/run", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);

  const url = new URL(c.req.url);
  const forceRefresh = url.searchParams.get("force_refresh") === "true";
  const triggeredBy = c.var.email || "unknown";

  // Viewer entity is derived server-side from the authenticated email
  // — NEVER taken from the query string (that would be an IDOR surface
  // letting any authenticated caller request intro-graph results from
  // an arbitrary viewer's perspective). Callers MAY pass
  // viewer_entity_id as a hint, but it MUST equal the server-resolved
  // entity for the authenticated caller, otherwise we 403.
  const callerViewerEntity = await resolveCallerViewerEntity(c);
  const requestedViewer = url.searchParams.get("viewer_entity_id");
  if (requestedViewer && requestedViewer !== callerViewerEntity) {
    return c.json({
      error: "viewer_mismatch",
      message: "viewer_entity_id must match the authenticated caller's entity",
    }, 403);
  }
  const viewerEntityId = callerViewerEntity;

  if (forceRefresh && !isOperator(c)) {
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

  // Insert the run header BEFORE dispatch so the workflow_run_id update
  // below always lands on a real row (eliminates the dispatch-vs-
  // orchestrator race). The orchestrator UPSERTs this row, transitioning
  // status: queued → running and filling in the privacy fields.
  const queuedAt = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO profiler_runs
       (id, entity_id, status, triggered_by, force_refresh, started_at)
       VALUES (?, ?, 'queued', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(runId, entityId, triggeredBy, forceRefresh ? 1 : 0, queuedAt).run()
    .catch((e) => console.warn("profilers: queued-header insert failed", (e as Error).message));

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

// Task #6: lightweight audit hook for "view sensitive section" events
// from the Intelligence tab. Best-effort write into pii_audit_log so
// every operator open of a privacy-toggled subsection is grep-able.
// Action is constrained to a small allowlist so this can't be abused
// as a generic audit-log writer.
profilers.post("/:entity_id/audit", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  const body = (await c.req.json().catch(() => null)) as { action?: string } | null;
  const action = String(body?.action ?? "").slice(0, 64);
  const ALLOWED = new Set(["dossier_sensitive_open", "dossier_view"]);
  if (!ALLOWED.has(action)) return c.json({ error: "bad_action" }, 400);
  const actor = c.var.email || "unknown";
  try {
    await c.env.DB.prepare(
      `INSERT INTO pii_audit_log (id, entity_id, actor_email, action, observed_at, request_id, notes)
         VALUES (?, ?, ?, ?, datetime('now'), ?, NULL)`,
    ).bind(crypto.randomUUID(), entityId, actor, action, c.req.header("cf-ray") ?? "").run();
  } catch { /* table may not exist in some envs — non-fatal */ }
  return c.json({ ok: true });
});

// Task #6: dossier right-rail feed — most recent fact mutations.
profilers.get("/:entity_id/changelog", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "10")));
  const rows = await c.env.DB.prepare(
    `SELECT id, predicate, value_text, value_number, source_kind, source,
            evidence_url, confidence, observed_at
       FROM facts
      WHERE entity_id = ?
      ORDER BY observed_at DESC
      LIMIT ?`,
  ).bind(entityId, limit).all().catch(() => null);
  return c.json({ entity_id: entityId, items: rows?.results ?? [] });
});

// Task #6: distinct source/source_kind list backing the "Sources" rail.
profilers.get("/:entity_id/sources", async (c) => {
  const entityId = c.req.param("entity_id");
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT source_kind,
            COALESCE(source, '(unspecified)') AS source,
            COUNT(*) AS n,
            MAX(observed_at) AS last_seen
       FROM facts
      WHERE entity_id = ?
      GROUP BY source_kind, source
      ORDER BY n DESC, last_seen DESC
      LIMIT 30`,
  ).bind(entityId).all().catch(() => null);
  return c.json({ entity_id: entityId, items: rows?.results ?? [] });
});

profilers.get("/:entity_id/dossier", async (c) => {
  const entityId = c.req.param("entity_id");
  const noCache = c.req.query("no_cache") === "true";

  // Viewer entity is derived server-side from the authenticated email
  // — never from a query param. Same justification as the POST handler:
  // viewer-specific warm-intro paths are sensitive relationship-graph
  // data and cannot be requested on someone else's behalf. We accept
  // viewer_entity_id only as a consistency hint and 403 on mismatch.
  const callerViewerEntity = await resolveCallerViewerEntity(c);
  const requestedViewer = c.req.query("viewer_entity_id");
  if (requestedViewer && requestedViewer !== callerViewerEntity) {
    return c.json({
      error: "viewer_mismatch",
      message: "viewer_entity_id must match the authenticated caller's entity",
    }, 403);
  }
  const viewerEntityId = callerViewerEntity;

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
