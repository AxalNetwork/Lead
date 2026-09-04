// Task #9: Runner-facing endpoints.
//
//   POST /api/compute/register-exchange  (no JWT — bearer is the
//     short-lived registration token)
//   POST /api/compute/heartbeat          (signed envelope)
//   POST /api/compute/pull               (signed envelope; long-poll-ish)
//   POST /api/compute/complete           (signed envelope)
//
// These bypass the /api/* accessGuard mount because the runner is a
// non-browser client whose identity is the per-node HMAC secret minted
// in registration. Mounted explicitly in src/index.ts BEFORE the
// accessGuard middleware is applied to its sibling /api/* routes.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  consumeRegistrationToken,
  mintNodeSecret,
  readNodeSecret,
  shortId,
} from "../services/compute/registration";
import {
  popPending,
  runComputeWatchdog,
  type ComputeNodeRow,
} from "../services/compute/dispatcher";
import {
  kvNonceStore,
  verifyEnvelope,
  type Envelope,
} from "../services/compute/envelope";
import { computeCostUsd } from "../services/compute/cost";

export const computeRunnerRoute = new Hono<{ Bindings: Env; Variables: { node?: ComputeNodeRow } }>();

// Pre-flight ping (unauthenticated). Lets the runner verify the
// endpoint is reachable before exchanging its registration token.
computeRunnerRoute.get("/", (c) =>
  c.json({ ok: true, service: "compute-runner", envelope_ttl_ms: 60_000 }),
);

// ---------------------------------------------------------------- register
computeRunnerRoute.post("/register-exchange", async (c) => {
  let body: { registration_token?: string; endpoint_url?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const tok = body.registration_token;
  if (!tok || typeof tok !== "string") return c.json({ error: "missing_token" }, 400);
  const reg = await consumeRegistrationToken(c.env, tok);
  if (!reg) return c.json({ error: "invalid_or_expired_token" }, 401);

  const nodeId = shortId("node_");
  const { secret, kvKey } = await mintNodeSecret(c.env, nodeId);

  await c.env.DB.prepare(
    `INSERT INTO compute_nodes
       (id, name, provider, kind, endpoint_url, auth_secret_kv_key,
        supported_job_types, capabilities_json, max_concurrent_jobs,
        current_active_jobs, cost_per_hour_usd, cost_per_1k_tokens_usd,
        enabled, drain, registered_by, registered_at, last_heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 0, ?, datetime('now'), ?)`,
  ).bind(
    nodeId,
    reg.name,
    reg.provider,
    reg.kind,
    body.endpoint_url ?? null,
    kvKey,
    JSON.stringify(reg.supported_job_types),
    JSON.stringify(reg.capabilities_json),
    reg.max_concurrent_jobs,
    reg.cost_per_hour_usd,
    reg.cost_per_1k_tokens_usd,
    reg.registered_by,
    // last_heartbeat_at in ISO-8601 to match the watchdog's ISO cutoff
    // (see the heartbeat handler below).
    new Date().toISOString(),
  ).run();

  return c.json({
    node_id: nodeId,
    hmac_secret: secret, // ONE-TIME — never re-readable
    endpoint: "https://api.aidatasignal.com/api/compute",
  });
});

// ---------------------------------------------------------------- envelope auth
async function authenticateEnvelope(
  c: { env: Env; req: { json: () => Promise<unknown> } },
  bodyText: string,
  envHeader: string | null,
): Promise<{ ok: true; node: ComputeNodeRow } | { ok: false; status: number; error: string }> {
  if (!envHeader) return { ok: false, status: 401, error: "missing_envelope" };
  let envObj: Envelope;
  try { envObj = JSON.parse(envHeader) as Envelope; } catch { return { ok: false, status: 400, error: "bad_envelope_json" }; }
  if (!envObj.node_id) return { ok: false, status: 400, error: "missing_node_id" };
  const node = await c.env.DB.prepare(
    `SELECT id, name, provider, kind, endpoint_url, auth_secret_kv_key,
            supported_job_types, capabilities_json,
            max_concurrent_jobs, current_active_jobs,
            cost_per_hour_usd, cost_per_1k_tokens_usd,
            enabled, drain, last_heartbeat_at, last_error
       FROM compute_nodes WHERE id = ?`,
  ).bind(envObj.node_id).first<ComputeNodeRow>();
  if (!node) return { ok: false, status: 401, error: "unknown_node" };
  const secret = await readNodeSecret(c.env, node.auth_secret_kv_key);
  if (!secret) return { ok: false, status: 401, error: "node_secret_missing" };
  const v = await verifyEnvelope(secret, envObj, bodyText);
  if (!v.ok) return { ok: false, status: 401, error: v.reason };
  const nonces = kvNonceStore(c.env.SESSIONS);
  if (await nonces.seen(envObj.nonce)) return { ok: false, status: 401, error: "nonce_replay" };
  await nonces.remember(envObj.nonce);
  return { ok: true, node };
}

// ---------------------------------------------------------------- heartbeat
computeRunnerRoute.post("/heartbeat", async (c) => {
  const bodyText = await c.req.text();
  const auth = await authenticateEnvelope(c, bodyText, c.req.header("X-Compute-Envelope") ?? null);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status as 400 | 401);
  let body: { current_active_jobs?: number; last_error?: string | null } = {};
  if (bodyText) { try { body = JSON.parse(bodyText); } catch { /* tolerate */ } }
  const active = Math.max(0, Number(body.current_active_jobs ?? 0));
  // ISO-8601, NOT datetime('now'): the watchdog compares this column against
  // an ISO cutoff, and SQLite compares TEXT bytewise ("2026-.. 10:00" sorts
  // below "2026-..T09:59" because ' ' < 'T'), which used to disable every
  // node on its very next heartbeat.
  await c.env.DB.prepare(
    `UPDATE compute_nodes
        SET last_heartbeat_at = ?,
            current_active_jobs = ?,
            last_error = ?,
            enabled = CASE WHEN last_error = 'heartbeat_timeout' THEN 1 ELSE enabled END
      WHERE id = ?`,
  ).bind(new Date().toISOString(), active, body.last_error ?? null, auth.node.id).run();
  // Piggyback watchdog on every heartbeat — cheap and bounded.
  // Skip on the heartbeating node itself by short-circuiting in the
  // sweep (it just refreshed last_heartbeat_at to now).
  c.executionCtx.waitUntil(runComputeWatchdog(c.env).catch(() => undefined));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- pull
computeRunnerRoute.post("/pull", async (c) => {
  const bodyText = await c.req.text();
  const auth = await authenticateEnvelope(c, bodyText, c.req.header("X-Compute-Envelope") ?? null);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status as 400 | 401);
  let body: { max?: number } = {};
  if (bodyText) { try { body = JSON.parse(bodyText); } catch { /* tolerate */ } }
  const max = Math.max(1, Math.min(10, Number(body.max ?? 1)));
  if (auth.node.drain) return c.json({ jobs: [], reason: "drain" });
  const jobs = await popPending(c.env, auth.node.id, max);
  for (const j of jobs) {
    await c.env.DB.prepare(
      `UPDATE compute_job_assignments
          SET status = 'running', started_at = datetime('now')
        WHERE id = ? AND status = 'dispatched'`,
    ).bind(j.assignment_id).run();
  }
  return c.json({ jobs });
});

// ---------------------------------------------------------------- complete
computeRunnerRoute.post("/complete", async (c) => {
  const bodyText = await c.req.text();
  const auth = await authenticateEnvelope(c, bodyText, c.req.header("X-Compute-Envelope") ?? null);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status as 400 | 401);
  let body: {
    assignment_id?: string;
    status?: "completed" | "failed" | "unsupported";
    runtime_ms?: number;
    tokens_used?: number;
    error?: string | null;
    result?: unknown;
    output_r2_key?: string | null;
  };
  try { body = JSON.parse(bodyText); } catch { return c.json({ error: "bad_json" }, 400); }
  if (!body.assignment_id) return c.json({ error: "missing_assignment_id" }, 400);

  const asg = await c.env.DB.prepare(
    `SELECT id, node_id, status FROM compute_job_assignments WHERE id = ?`,
  ).bind(body.assignment_id).first<{ id: string; node_id: string; status: string }>();
  if (!asg) return c.json({ error: "unknown_assignment" }, 404);
  if (asg.node_id !== auth.node.id) return c.json({ error: "wrong_node" }, 403);
  if (asg.status !== "running" && asg.status !== "dispatched") {
    return c.json({ ok: true, ignored: true, prior_status: asg.status });
  }

  const status = body.status === "completed" || body.status === "failed" || body.status === "unsupported"
    ? body.status : "failed";
  const runtime = Math.max(0, Number(body.runtime_ms ?? 0));
  const tokens = Math.max(0, Number(body.tokens_used ?? 0));
  const cost = computeCostUsd({
    runtime_ms: runtime,
    tokens_used: tokens,
    cost_per_hour_usd: auth.node.cost_per_hour_usd,
    cost_per_1k_tokens_usd: auth.node.cost_per_1k_tokens_usd,
  });
  const resultJson = body.result === undefined ? null : JSON.stringify(body.result).slice(0, 8000);

  await c.env.DB.prepare(
    `UPDATE compute_job_assignments
        SET status = ?, completed_at = datetime('now'),
            runtime_ms = ?, tokens_used = ?, cost_usd = ?,
            error = ?, result_json = ?, output_r2_key = ?
      WHERE id = ?`,
  ).bind(status, runtime, tokens, cost, body.error ?? null, resultJson, body.output_r2_key ?? null, body.assignment_id).run();

  await c.env.DB.prepare(
    `UPDATE compute_nodes
        SET current_active_jobs = MAX(0, current_active_jobs - 1)
      WHERE id = ?`,
  ).bind(auth.node.id).run();

  return c.json({ ok: true, cost_usd: cost });
});
