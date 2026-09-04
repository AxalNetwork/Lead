// Task #9: Dispatcher + watchdog + pending FIFO.
//
// pickNode(jobType, payloadSize) → node | null. Filters by enabled=1,
// drain=0, fresh heartbeat (<90s), supported_job_types, and
// current_active_jobs < max_concurrent_jobs. Ranks by total cost
// estimate. Returns null when nothing fits — caller falls back to the
// in-Workers path or queues for retry.
//
// The dispatcher MUST NOT await an external job inline — it stores
// the assignment, returns, and the result arrives via /complete.

import type { Env } from "../../types";
import { computeCostUsd } from "./cost";
import { DEFAULT_ROUTING_MATRIX, resolveRule, type JobType, type NodeKind, type RoutingRule } from "./routing";
import { shortId } from "./registration";

export const HEARTBEAT_FRESH_MS = 90_000;
export const PENDING_QUEUE_PREFIX = "compute:pending:";
export const PAYLOAD_INLINE_MAX_BYTES = 256 * 1024;

export interface ComputeNodeRow {
  id: string;
  name: string;
  provider: string;
  kind: NodeKind;
  endpoint_url: string | null;
  auth_secret_kv_key: string;
  supported_job_types: string;   // JSON array
  capabilities_json: string;     // JSON object
  max_concurrent_jobs: number;
  current_active_jobs: number;
  cost_per_hour_usd: number;
  cost_per_1k_tokens_usd: number;
  enabled: number;
  drain: number;
  last_heartbeat_at: string | null;
  last_error: string | null;
}

function parseList(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function parseObj(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
}

interface RankedNode {
  row: ComputeNodeRow;
  estimated_cost_usd: number;
}

export interface PickNodeOptions {
  /** Estimated runtime in ms (defaults to the rule's deadline). */
  est_runtime_ms?: number;
  /** Estimated token count (for LLM/embedding jobs). */
  est_tokens?: number;
  /** Per-deployment routing override (defaults to none). */
  rule?: Partial<RoutingRule>;
  /** Optional ms timestamp for testing. */
  nowMs?: number;
}

/** Pick the cheapest eligible node, or null if nothing fits. */
export function pickNodeFromList(
  jobType: JobType,
  payloadBytes: number,
  nodes: ComputeNodeRow[],
  opts: PickNodeOptions = {},
): ComputeNodeRow | null {
  const rule = resolveRule(jobType, opts.rule);
  if (!rule.external_ok) return null;
  const now = opts.nowMs ?? Date.now();
  const eligible: RankedNode[] = [];
  for (const n of nodes) {
    if (!n.enabled || n.drain) continue;
    const hb = n.last_heartbeat_at ? Date.parse(n.last_heartbeat_at) : NaN;
    if (!Number.isFinite(hb) || now - hb > HEARTBEAT_FRESH_MS) continue;
    if (n.current_active_jobs >= n.max_concurrent_jobs) continue;
    const sjt = parseList(n.supported_job_types);
    if (!sjt.includes(jobType)) continue;
    if (rule.preferred_kinds.length && !rule.preferred_kinds.includes(n.kind)) {
      // Allow if the per-node override explicitly opts in; otherwise skip.
      const caps = parseObj(n.capabilities_json);
      if (caps.allow_all_kinds !== true) continue;
    }
    void payloadBytes; // size is informational; large payloads go via R2
    const cost = computeCostUsd({
      runtime_ms: opts.est_runtime_ms ?? rule.deadline_ms,
      tokens_used: opts.est_tokens ?? 0,
      cost_per_hour_usd: n.cost_per_hour_usd,
      cost_per_1k_tokens_usd: n.cost_per_1k_tokens_usd,
    });
    eligible.push({ row: n, estimated_cost_usd: cost });
  }
  if (!eligible.length) return null;
  // Cheapest first; tie-break by kind preference order (gpu before
  // cpu when both qualify for a gpu-preferred rule) then by name.
  const kindRank = new Map(rule.preferred_kinds.map((k, i) => [k, i]));
  eligible.sort((a, b) => {
    if (a.estimated_cost_usd !== b.estimated_cost_usd) return a.estimated_cost_usd - b.estimated_cost_usd;
    const ka = kindRank.get(a.row.kind) ?? 99;
    const kb = kindRank.get(b.row.kind) ?? 99;
    if (ka !== kb) return ka - kb;
    return a.row.name.localeCompare(b.row.name);
  });
  return eligible[0].row;
}

export async function loadEligibleNodes(env: Env): Promise<ComputeNodeRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, name, provider, kind, endpoint_url, auth_secret_kv_key,
            supported_job_types, capabilities_json,
            max_concurrent_jobs, current_active_jobs,
            cost_per_hour_usd, cost_per_1k_tokens_usd,
            enabled, drain, last_heartbeat_at, last_error
       FROM compute_nodes
      WHERE enabled = 1 AND drain = 0`,
  ).all<ComputeNodeRow>().catch(() => ({ results: [] as ComputeNodeRow[] }));
  return r.results ?? [];
}

export async function pickNode(
  env: Env,
  jobType: JobType,
  payloadBytes: number,
  opts: PickNodeOptions = {},
): Promise<ComputeNodeRow | null> {
  const nodes = await loadEligibleNodes(env);
  return pickNodeFromList(jobType, payloadBytes, nodes, opts);
}

// ---------- pending FIFO (KV-backed) ------------------------------------
//
// Per-node pending queue: each push appends an asg_id to a list under
// PENDING_QUEUE_PREFIX + node_id. Pull (long-poll) drains FIFO.

interface PendingEnvelope {
  assignment_id: string;
  job_id: string;
  job_type: string;
  payload: unknown;               // inline payload <= 256KB; else null
  payload_r2_key: string | null;  // R2 key for >256KB payloads
  output_r2_required: boolean;
  deadline_at: string;
  dispatched_at: string;
}

export async function pushPending(env: Env, nodeId: string, env_: PendingEnvelope): Promise<void> {
  const key = PENDING_QUEUE_PREFIX + nodeId;
  const raw = (await env.SESSIONS.get(key)) ?? "[]";
  let list: PendingEnvelope[];
  try { list = JSON.parse(raw); if (!Array.isArray(list)) list = []; } catch { list = []; }
  list.push(env_);
  await env.SESSIONS.put(key, JSON.stringify(list));
}

export async function popPending(env: Env, nodeId: string, max: number): Promise<PendingEnvelope[]> {
  const key = PENDING_QUEUE_PREFIX + nodeId;
  const raw = (await env.SESSIONS.get(key)) ?? "[]";
  let list: PendingEnvelope[];
  try { list = JSON.parse(raw); if (!Array.isArray(list)) list = []; } catch { list = []; }
  const out = list.splice(0, max);
  await env.SESSIONS.put(key, JSON.stringify(list));
  return out;
}

// ---------- dispatch + result intake ------------------------------------

export interface DispatchInput {
  job_id: string;
  job_type: JobType;
  payload: unknown;
  /** Optional override deadline (ms from now). */
  deadline_ms?: number;
  /** Optional per-deployment routing override. */
  rule?: Partial<RoutingRule>;
}

export interface DispatchResult {
  status: "dispatched" | "no_node";
  assignment_id?: string;
  node_id?: string;
  reason?: string;
}

export async function dispatchExternalJob(env: Env, input: DispatchInput): Promise<DispatchResult> {
  const rule = resolveRule(input.job_type, input.rule);
  const payloadStr = JSON.stringify(input.payload ?? null);
  const payloadBytes = new TextEncoder().encode(payloadStr).length;
  const node = await pickNode(env, input.job_type, payloadBytes, { rule: input.rule });
  if (!node) return { status: "no_node", reason: "no_eligible_node" };

  let payloadInline: unknown = input.payload ?? null;
  let payloadR2Key: string | null = null;
  if (payloadBytes > PAYLOAD_INLINE_MAX_BYTES) {
    // Stash payload in R2 for the runner to fetch out-of-band.
    payloadInline = null;
    payloadR2Key = `compute/payloads/${input.job_id}.json`;
    const bucket = env.RAW_HTML; // reuse the existing R2 binding
    if (bucket) {
      await bucket.put(payloadR2Key, payloadStr, { httpMetadata: { contentType: "application/json" } });
    } else {
      return { status: "no_node", reason: "r2_unavailable_for_large_payload" };
    }
  }

  const asgId = shortId("asg_");
  const deadlineMs = input.deadline_ms ?? rule.deadline_ms;
  const deadlineAt = new Date(Date.now() + deadlineMs).toISOString();

  await env.DB.prepare(
    `INSERT INTO compute_job_assignments
       (id, node_id, job_id, job_type, payload_bytes, payload_r2_key,
        status, deadline_at, dispatched_at)
     VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'))`,
  ).bind(asgId, node.id, input.job_id, input.job_type, payloadBytes, payloadR2Key, deadlineAt).run();

  await env.DB.prepare(
    `UPDATE compute_nodes
       SET current_active_jobs = current_active_jobs + 1
     WHERE id = ?`,
  ).bind(node.id).run();

  await pushPending(env, node.id, {
    assignment_id: asgId,
    job_id: input.job_id,
    job_type: input.job_type,
    payload: payloadInline,
    payload_r2_key: payloadR2Key,
    output_r2_required: false,
    deadline_at: deadlineAt,
    dispatched_at: new Date().toISOString(),
  });

  return { status: "dispatched", assignment_id: asgId, node_id: node.id };
}

// ---------- watchdog ------------------------------------------------------
//
// Missed 3 consecutive 30s heartbeats (90s) → mark node disabled,
// set last_error='heartbeat_timeout', and re-enqueue its open
// assignments. Piggybacks on dispatcher invocations + nightly tick.

export interface WatchdogResult {
  nodes_disabled: number;
  assignments_reassigned: number;
  assignments_timed_out: number;
}

export async function runComputeWatchdog(env: Env, nowMs = Date.now()): Promise<WatchdogResult> {
  const out: WatchdogResult = { nodes_disabled: 0, assignments_reassigned: 0, assignments_timed_out: 0 };
  const staleCutoff = new Date(nowMs - HEARTBEAT_FRESH_MS).toISOString();

  // Find stale enabled nodes with at least one open assignment OR a
  // missed heartbeat regardless. We disable + reassign in one pass.
  const stale = await env.DB.prepare(
    `SELECT id FROM compute_nodes
      WHERE enabled = 1
        AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
  ).bind(staleCutoff).all<{ id: string }>().catch(() => ({ results: [] as { id: string }[] }));

  for (const n of stale.results ?? []) {
    await env.DB.prepare(
      `UPDATE compute_nodes
          SET enabled = 0, last_error = 'heartbeat_timeout'
        WHERE id = ?`,
    ).bind(n.id).run();
    out.nodes_disabled++;
    const open = await env.DB.prepare(
      `SELECT id, job_id, job_type FROM compute_job_assignments
        WHERE node_id = ? AND status IN ('dispatched','running')`,
    ).bind(n.id).all<{ id: string; job_id: string; job_type: string }>()
      .catch(() => ({ results: [] as { id: string; job_id: string; job_type: string }[] }));
    for (const asg of open.results ?? []) {
      await env.DB.prepare(
        `UPDATE compute_job_assignments
            SET status = 'reassigned', completed_at = datetime('now'),
                error = 'node_heartbeat_timeout'
          WHERE id = ?`,
      ).bind(asg.id).run();
      out.assignments_reassigned++;
      // We do NOT auto re-dispatch here — caller's queue retry path
      // owns the next attempt. The reassigned status + error column
      // makes the lost work visible without silently retrying onto a
      // possibly-broken node.
    }
    await env.DB.prepare(
      `UPDATE compute_nodes SET current_active_jobs = 0 WHERE id = ?`,
    ).bind(n.id).run();
  }

  // Independent of node health: any dispatched/running assignment
  // whose deadline has elapsed is marked timeout.
  // deadline_at is written as ISO-8601 (see dispatchExternalJob), so compare
  // against an ISO 'now' — datetime('now') is space-separated and sorts BELOW
  // every ISO timestamp of the same day, which made elapsed deadlines
  // invisible until the next UTC date rollover.
  const elapsed = await env.DB.prepare(
    `SELECT id, node_id FROM compute_job_assignments
      WHERE status IN ('dispatched','running')
        AND deadline_at < ?`,
  ).bind(new Date(nowMs).toISOString())
    .all<{ id: string; node_id: string }>().catch(() => ({ results: [] as { id: string; node_id: string }[] }));
  for (const asg of elapsed.results ?? []) {
    await env.DB.prepare(
      `UPDATE compute_job_assignments
          SET status = 'timeout', completed_at = datetime('now'),
              error = 'deadline_exceeded'
        WHERE id = ?`,
    ).bind(asg.id).run();
    await env.DB.prepare(
      `UPDATE compute_nodes
          SET current_active_jobs = MAX(0, current_active_jobs - 1)
        WHERE id = ?`,
    ).bind(asg.node_id).run();
    out.assignments_timed_out++;
  }

  return out;
}

export { DEFAULT_ROUTING_MATRIX };
