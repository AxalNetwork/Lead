// Task #5: System Health & Errors Dashboard — admin-only ops API.
//
// All routes inherit accessGuard + adminOnly from the parent
// /api/ops/* mount in index.ts. Mutating endpoints write an
// ops_audit row BEFORE the side-effect, matching the ops_crawler
// precedent.
//
// Snapshot freshness: this route writes an on-demand snapshot if
// the last one is older than 5 minutes — the cron-budget reality
// is the hourly tick, so reads in between get fresh data via this
// opportunistic write rather than stale rollups.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  collectComputePool,
  collectQueues,
  collectD1,
  collectR2,
  collectKV,
  collectVectorize,
  collectRecentErrors,
  collectErrorRatePerMin,
  collectCronStatus,
  collectExternalApis,
  collectWorkerCards,
} from "../services/systemHealth/collectors";
import { writeHealthSnapshot } from "../services/systemHealth/snapshot";
import { runProbe, runAllProbes, findProbe, writeProbe, PROBE_NAMES, PROBE_REGISTRY } from "../services/systemHealth/probes";
import { runAlertEvaluator } from "../services/systemHealth/alerts";

type Vars = { email: string; is_admin: boolean; request_id: string };

export const opsSystemHealthRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

async function audit(
  env: Env, actor: string, action: string,
  target_kind: string | null, target_id: string | null, payload: unknown,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ops_audit (actor_email, action, target_kind, target_id, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(actor, action, target_kind, target_id, JSON.stringify(payload)).run();
  } catch (e) {
    throw new Error(`ops_audit insert failed: ${(e as Error).message}`);
  }
}

async function maybeWriteFreshSnapshot(env: Env): Promise<void> {
  try {
    const last = await env.DB.prepare(
      `SELECT MAX(bucket_start) AS t FROM health_snapshots`,
    ).first<{ t: string | null }>();
    const lastT = last?.t ? new Date(last.t).getTime() : 0;
    if (Date.now() - lastT > 5 * 60_000) {
      await writeHealthSnapshot(env);
    }
  } catch { /* missing-table — first run before migration applied; ignore */ }
}

// GET /api/ops/system-health — page-level pre-flight + full aggregator.
opsSystemHealthRoute.get("/", async (c) => {
  await maybeWriteFreshSnapshot(c.env);
  const [compute, workers, queues, d1, r2, kv, vec, errors, errorsPerMin, crons, externalApis, openIncidents] = await Promise.all([
    collectComputePool(c.env),
    collectWorkerCards(c.env),
    collectQueues(c.env),
    collectD1(c.env),
    collectR2(c.env),
    collectKV(c.env),
    collectVectorize(c.env),
    collectRecentErrors(c.env, 100),
    collectErrorRatePerMin(c.env),
    collectCronStatus(c.env),
    collectExternalApis(c.env, [...PROBE_NAMES]),
    c.env.DB.prepare(
      `SELECT id, opened_at, severity, kind, signature, summary
         FROM ops_incidents
        WHERE closed_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 50`,
    ).all<{ id: string; opened_at: string; severity: string; kind: string; signature: string; summary: string }>()
      .then((r) => r.results ?? [])
      .catch(() => []),
  ]);
  return c.json({
    generated_at: new Date().toISOString(),
    compute_pool: compute,
    workers,
    queues,
    d1,
    r2,
    kv,
    vectorize: vec,
    external_apis: externalApis,
    crons,
    errors: { recent: errors, per_min: errorsPerMin },
    open_incidents: openIncidents,
  });
});

// POST /api/ops/system-health/snapshot — force a snapshot write (dev/debug).
opsSystemHealthRoute.post("/snapshot", async (c) => {
  await audit(c.env, c.var.email, "system_health.snapshot", null, null, {});
  const r = await writeHealthSnapshot(c.env);
  return c.json(r);
});

// POST /api/ops/system-health/evaluate — force the alert evaluator (dev/debug).
opsSystemHealthRoute.post("/evaluate", async (c) => {
  await audit(c.env, c.var.email, "system_health.evaluate", null, null, {});
  const r = await runAlertEvaluator(c.env);
  return c.json(r);
});

// POST /api/ops/system-health/probe/:api — run a probe synchronously.
opsSystemHealthRoute.post("/probe/:api", async (c) => {
  const api = c.req.param("api");
  const def = findProbe(api);
  if (!def) return c.json({ error: "unknown_api", api }, 404);
  await audit(c.env, c.var.email, "system_health.probe", "external_api", api, {});
  const r = await runProbe(c.env, def);
  await writeProbe(c.env, r);
  return c.json(r);
});

// POST /api/ops/system-health/probe-all — probe every registered API now.
opsSystemHealthRoute.post("/probe-all", async (c) => {
  await audit(c.env, c.var.email, "system_health.probe_all", null, null, { count: PROBE_REGISTRY.length });
  const r = await runAllProbes(c.env);
  return c.json({ probed: r.length, results: r });
});

// POST /api/ops/system-health/nodes/:id/drain — admin drain a compute node.
opsSystemHealthRoute.post("/nodes/:id/drain", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({} as { drain?: boolean }));
  const drain = body.drain === undefined ? 1 : (body.drain ? 1 : 0);
  await audit(c.env, c.var.email, drain ? "system_health.node_drain" : "system_health.node_undrain", "compute_node", id, { drain });
  try {
    const r = await c.env.DB.prepare(
      `UPDATE compute_nodes SET drain = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(drain, id).run();
    if (!r.meta?.changes) return c.json({ error: "not_found", id }, 404);
    return c.json({ ok: true, id, drain });
  } catch (e) {
    return c.json({ error: "db_error", message: (e as Error).message }, 500);
  }
});

// GET /api/ops/system-health/incidents — list with status filter.
opsSystemHealthRoute.get("/incidents", async (c) => {
  const status = (c.req.query("status") ?? "all").toLowerCase();
  let where = "1=1";
  if (status === "open") where = "closed_at IS NULL";
  else if (status === "closed") where = "closed_at IS NOT NULL";
  const rows = await c.env.DB.prepare(
    `SELECT id, opened_at, closed_at, severity, kind, signature, summary,
            acked_at, acked_by, delivery_status
       FROM ops_incidents
      WHERE ${where}
      ORDER BY opened_at DESC
      LIMIT 200`,
  ).all<{
    id: string; opened_at: string; closed_at: string | null;
    severity: string; kind: string; signature: string; summary: string;
    acked_at: string | null; acked_by: string | null; delivery_status: string | null;
  }>().catch(() => ({ results: [] as Array<Record<string, unknown>> }));
  return c.json({ incidents: rows.results ?? [] });
});

// GET /api/ops/system-health/incidents/by-id?id=<incident_id> — detail view.
opsSystemHealthRoute.get("/incidents/by-id", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT * FROM ops_incidents WHERE id = ? LIMIT 1`,
  ).bind(id).first<Record<string, unknown>>().catch(() => null);
  if (!row) return c.json({ error: "not_found", id }, 404);
  // Per the Task #4 static-routing/incident-hydration constraint, the
  // timeline page hydrates STRICTLY from the `context_json` payload
  // captured at incident open — never re-queries the underlying gauge
  // tables. This guarantees the displayed timeline reflects the actual
  // platform state at the moment the alert fired, even if rollups have
  // since been overwritten or pruned.
  let context: Record<string, unknown> = {};
  if (typeof row.context_json === "string" && row.context_json.length) {
    try { context = JSON.parse(row.context_json) as Record<string, unknown>; }
    catch { context = { parse_error: "context_json invalid JSON" }; }
  }
  return c.json({ incident: row, context });
});

// PATCH /api/ops/system-health/incidents/by-id?id=<id> — edit resolution_notes / ack.
opsSystemHealthRoute.patch("/incidents/by-id", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);
  const body = await c.req.json().catch(() => ({} as { resolution_notes?: string; ack?: boolean; close?: boolean }));
  await audit(c.env, c.var.email, "system_health.incident_update", "incident", id, body);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof body.resolution_notes === "string") {
    sets.push("resolution_notes = ?");
    args.push(body.resolution_notes.slice(0, 4000));
  }
  if (body.ack) {
    sets.push("acked_at = COALESCE(acked_at, datetime('now'))");
    sets.push("acked_by = COALESCE(acked_by, ?)");
    args.push(c.var.email);
  }
  if (body.close) {
    sets.push("closed_at = COALESCE(closed_at, datetime('now'))");
  }
  if (!sets.length) return c.json({ error: "no_changes" }, 400);
  sets.push("updated_at = datetime('now')");
  args.push(id);
  try {
    const r = await c.env.DB.prepare(
      `UPDATE ops_incidents SET ${sets.join(", ")} WHERE id = ?`,
    ).bind(...args).run();
    if (!r.meta?.changes) return c.json({ error: "not_found", id }, 404);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "db_error", message: (e as Error).message }, 500);
  }
});
