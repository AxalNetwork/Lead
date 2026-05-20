// Task #9: /api/ops/compute-nodes — admin console backend.
//
// All routes inherit `accessGuard` + `adminOnly` from the parent
// `/api/ops/*` mount in src/index.ts. The pre-flight gate pattern
// from Task #2 (/ops/crawler/) is reused on the Jekyll page — the
// JS pre-flights GET /api/ops/compute-nodes/ and only reveals the
// page body on a 2xx response.
//
// Per the Task #4 static-routing constraint, every deep link uses
// `?id=<node_id>` query strings, never `/:id` path segments.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  mintRegistrationToken,
  deleteNodeSecret,
  type PendingRegistration,
} from "../services/compute/registration";
import { runComputeWatchdog } from "../services/compute/dispatcher";
import { DEFAULT_ROUTING_MATRIX } from "../services/compute/routing";

export const opsComputeNodesRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

async function audit(env: Env, actor: string, action: string, targetId: string | null, payload: unknown): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ops_audit (actor_email, action, target_kind, target_id, payload_json)
       VALUES (?, ?, 'compute_node', ?, ?)`,
    ).bind(actor, action, targetId, payload === undefined ? null : JSON.stringify(payload)).run();
  } catch (e) {
    console.error("ops_audit insert failed", (e as Error).message);
  }
}

// Page-gate probe + endpoint discovery (mirrors /api/ops/crawler/).
opsComputeNodesRoute.get("/", (c) =>
  c.json({
    ok: true,
    message: "ops compute-nodes",
    routing_matrix: DEFAULT_ROUTING_MATRIX,
    endpoints: [
      "GET /",
      "GET /nodes",
      "GET /nodes/by-id?id=<node_id>",
      "GET /assignments?node_id=<id>&limit=50",
      "GET /spend?window=day|week",
      "POST /register-token  {name,provider,kind,supported_job_types,max_concurrent_jobs,cost_per_hour_usd,cost_per_1k_tokens_usd,capabilities_json}",
      "POST /nodes/by-id/pause?id=<node_id>",
      "POST /nodes/by-id/drain?id=<node_id>",
      "POST /nodes/by-id/resume?id=<node_id>",
      "DELETE /nodes/by-id?id=<node_id>",
      "POST /watchdog/run",
    ],
  }),
);

// ---------- read ----------
opsComputeNodesRoute.get("/nodes", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, name, provider, kind, supported_job_types,
            max_concurrent_jobs, current_active_jobs,
            cost_per_hour_usd, cost_per_1k_tokens_usd,
            enabled, drain, last_heartbeat_at, last_error,
            registered_by, registered_at
       FROM compute_nodes
      ORDER BY registered_at DESC`,
  ).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }));
  return c.json({ items: r.results ?? [] });
});

opsComputeNodesRoute.get("/nodes/by-id", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, name, provider, kind, endpoint_url, supported_job_types,
            capabilities_json, max_concurrent_jobs, current_active_jobs,
            cost_per_hour_usd, cost_per_1k_tokens_usd,
            enabled, drain, last_heartbeat_at, last_error,
            registered_by, registered_at, notes
       FROM compute_nodes WHERE id = ?`,
  ).bind(id).first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ node: row });
});

opsComputeNodesRoute.get("/assignments", async (c) => {
  const nodeId = c.req.query("node_id") || null;
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
  const where = nodeId ? `WHERE node_id = ?` : "";
  const sql = `SELECT id, node_id, job_id, job_type, status,
                      payload_bytes, runtime_ms, tokens_used, cost_usd,
                      deadline_at, dispatched_at, started_at,
                      completed_at, error
                 FROM compute_job_assignments
                 ${where}
                 ORDER BY dispatched_at DESC
                 LIMIT ?`;
  const stmt = nodeId
    ? c.env.DB.prepare(sql).bind(nodeId, limit)
    : c.env.DB.prepare(sql).bind(limit);
  const r = await stmt.all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }));
  return c.json({ items: r.results ?? [] });
});

opsComputeNodesRoute.get("/spend", async (c) => {
  const win = c.req.query("window") === "week" ? "week" : "day";
  const cutoff = win === "week"
    ? "datetime('now','-7 days')"
    : "datetime('now','-1 day')";
  const r = await c.env.DB.prepare(
    `SELECT cja.node_id, cn.name AS node_name, cn.provider, cn.kind,
            COUNT(*) AS jobs,
            SUM(CASE WHEN cja.status='completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN cja.status='failed'    THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN cja.status='timeout'   THEN 1 ELSE 0 END) AS timeouts,
            SUM(COALESCE(cja.runtime_ms,0)) AS runtime_ms,
            SUM(COALESCE(cja.cost_usd,0))   AS cost_usd
       FROM compute_job_assignments cja
       LEFT JOIN compute_nodes cn ON cn.id = cja.node_id
      WHERE cja.dispatched_at >= ${cutoff}
      GROUP BY cja.node_id, cn.name, cn.provider, cn.kind
      ORDER BY cost_usd DESC`,
  ).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }));
  const total = (r.results ?? []).reduce((s, row) => s + Number(row.cost_usd ?? 0), 0);
  return c.json({ window: win, total_cost_usd: total, by_node: r.results ?? [] });
});

// ---------- mutate ----------
opsComputeNodesRoute.post("/register-token", async (c) => {
  let body: Partial<PendingRegistration> & { registered_by?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "bad_json" }, 400); }
  const name = String(body.name ?? "").trim();
  const provider = String(body.provider ?? "self").trim();
  const kind = (body.kind === "gpu" || body.kind === "browser" ? body.kind : "cpu") as "cpu" | "gpu" | "browser";
  if (!name) return c.json({ error: "missing_name" }, 400);
  const sjt = Array.isArray(body.supported_job_types) ? body.supported_job_types.map(String) : [];
  if (!sjt.length) return c.json({ error: "missing_supported_job_types" }, 400);
  const reg = {
    name, provider, kind,
    supported_job_types: sjt,
    max_concurrent_jobs: Math.max(1, Math.min(64, Number(body.max_concurrent_jobs ?? 1))),
    cost_per_hour_usd: Math.max(0, Number(body.cost_per_hour_usd ?? 0)),
    cost_per_1k_tokens_usd: Math.max(0, Number(body.cost_per_1k_tokens_usd ?? 0)),
    capabilities_json: body.capabilities_json && typeof body.capabilities_json === "object"
      ? body.capabilities_json as Record<string, unknown>
      : {},
    registered_by: c.var.email,
  };
  const { token, expires_at } = await mintRegistrationToken(c.env, reg);
  await audit(c.env, c.var.email, "compute.register_token", null, { name, provider, kind, expires_at });
  return c.json({
    token,
    expires_at,
    command: `npx @axal/worker-runner --token=${token} --endpoint=https://api.aidatasignal.com/api/compute`,
  });
});

opsComputeNodesRoute.post("/nodes/by-id/pause", async (c) => {
  const id = c.req.query("id"); if (!id) return c.json({ error: "missing_id" }, 400);
  await audit(c.env, c.var.email, "compute.pause", id, null);
  await c.env.DB.prepare(`UPDATE compute_nodes SET enabled = 0 WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});
opsComputeNodesRoute.post("/nodes/by-id/drain", async (c) => {
  const id = c.req.query("id"); if (!id) return c.json({ error: "missing_id" }, 400);
  await audit(c.env, c.var.email, "compute.drain", id, null);
  await c.env.DB.prepare(`UPDATE compute_nodes SET drain = 1 WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});
opsComputeNodesRoute.post("/nodes/by-id/resume", async (c) => {
  const id = c.req.query("id"); if (!id) return c.json({ error: "missing_id" }, 400);
  await audit(c.env, c.var.email, "compute.resume", id, null);
  await c.env.DB.prepare(
    `UPDATE compute_nodes SET enabled = 1, drain = 0,
        last_error = CASE WHEN last_error = 'heartbeat_timeout' THEN NULL ELSE last_error END
      WHERE id = ?`,
  ).bind(id).run();
  return c.json({ ok: true });
});

opsComputeNodesRoute.delete("/nodes/by-id", async (c) => {
  const id = c.req.query("id"); if (!id) return c.json({ error: "missing_id" }, 400);
  const node = await c.env.DB.prepare(
    `SELECT id, auth_secret_kv_key FROM compute_nodes WHERE id = ?`,
  ).bind(id).first<{ id: string; auth_secret_kv_key: string }>();
  if (!node) return c.json({ error: "not_found" }, 404);
  await audit(c.env, c.var.email, "compute.delete", id, null);
  await deleteNodeSecret(c.env, node.auth_secret_kv_key);
  await c.env.DB.prepare(`DELETE FROM compute_nodes WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

opsComputeNodesRoute.post("/watchdog/run", async (c) => {
  const r = await runComputeWatchdog(c.env);
  return c.json({ ok: true, ...r });
});
