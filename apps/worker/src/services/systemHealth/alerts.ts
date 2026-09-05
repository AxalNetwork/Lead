// Task #5: alert evaluator + open/close/dedupe semantics.
//
// Reads the latest snapshot from collectors, checks the four hard
// thresholds, opens an ops_incidents row on first breach (dedupe by
// signature), and closes after two consecutive recovered checks.
// Recovery counters live in KV (SESSIONS) so they survive scheduler
// invocations without a dedicated table.
//
// Per the cron-budget constraint, this is invoked from the existing
// hourly cron — no new cron slot.

import type { Env } from "../../types";
import { collectComputePool, collectQueues, collectD1, collectErrorRatePerMin, nodeStatus, collectRecentErrors, collectExternalApis, collectCronStatus } from "./collectors";
import { PROBE_NAMES } from "./probes";
import { deliverEmail } from "../../monitoring/channels/email";

export interface Breach {
  kind: "queue_age" | "node_down" | "error_rate" | "d1_throttle";
  signature: string;
  severity: "warn" | "critical";
  summary: string;
  context: Record<string, unknown>;
}

export const THRESHOLDS = {
  QUEUE_AGE_SECONDS: 30 * 60,       // 30 min
  NODE_DOWN_SECONDS: 5 * 60,        // 5 min
  ERROR_RATE_PER_MIN: 5,            // > 5 errors/min ≈ 5%/min @ 100rpm; we use absolute count
  D1_THROTTLE_24H: 10,              // sustained > 10/24h
} as const;

export async function evaluateBreaches(env: Env): Promise<Breach[]> {
  const out: Breach[] = [];

  // 1. Queue age.
  const queues = await collectQueues(env);
  for (const q of queues) {
    if (q.oldest_age_seconds != null && q.oldest_age_seconds > THRESHOLDS.QUEUE_AGE_SECONDS) {
      out.push({
        kind: "queue_age",
        signature: `queue_age:${q.queue_name}`,
        severity: "critical",
        summary: `Queue "${q.queue_name}" oldest pending job is ${Math.round(q.oldest_age_seconds / 60)}m old (threshold 30m).`,
        context: { queue: q.queue_name, age_seconds: q.oldest_age_seconds, depth: q.depth },
      });
    }
  }

  // 2. Node down. Only count nodes that are operationally expected to
  // be heartbeating — explicitly disabled (`enabled=0`) or drained
  // (`drain=1`) nodes are admin-initiated states, not failures, even
  // though `nodeStatus()` paints them red/drained in the UI. Treating
  // them as breaches would generate false-positive incidents every
  // time an operator parks a node.
  const nodes = await collectComputePool(env);
  for (const n of nodes) {
    if (n.drain) continue;
    // A node the watchdog auto-disabled for a missed heartbeat is a
    // failure, not an admin-parked node — without this exemption the
    // 90s watchdog always won the race and `node_down` (5m) never fired.
    if (!n.enabled && n.last_error !== "heartbeat_timeout") continue;
    if (n.status === "red" && n.last_heartbeat_at) {
      const ageMs = Date.now() - new Date(n.last_heartbeat_at).getTime();
      if (ageMs > THRESHOLDS.NODE_DOWN_SECONDS * 1000) {
        out.push({
          kind: "node_down",
          signature: `node_down:${n.id}`,
          severity: "critical",
          summary: `Compute node "${n.name}" (${n.id}) has no heartbeat for ${Math.round(ageMs / 60000)}m (threshold 5m).`,
          context: { node_id: n.id, node_name: n.name, age_ms: ageMs, last_error: n.last_error },
        });
      }
    }
  }

  // 3. Error rate.
  const erate = await collectErrorRatePerMin(env);
  if (erate > THRESHOLDS.ERROR_RATE_PER_MIN) {
    out.push({
      kind: "error_rate",
      signature: `error_rate:global`,
      severity: erate > THRESHOLDS.ERROR_RATE_PER_MIN * 4 ? "critical" : "warn",
      summary: `Error log received ${erate} entries in the last minute (threshold ${THRESHOLDS.ERROR_RATE_PER_MIN}/min).`,
      context: { errors_per_min: erate },
    });
  }

  // 4. D1 throttling sustained.
  const d1 = await collectD1(env);
  if (d1.throttled_24h > THRESHOLDS.D1_THROTTLE_24H) {
    out.push({
      kind: "d1_throttle",
      signature: `d1_throttle:global`,
      severity: "warn",
      summary: `${d1.throttled_24h} D1 throttling events recorded in the last 24h.`,
      context: { throttled_24h: d1.throttled_24h, errors_24h: d1.errors_24h },
    });
  }

  return out;
}

interface DeliveryResult { email: string; slack: string; }

async function notify(env: Env, b: Breach): Promise<DeliveryResult> {
  const result: DeliveryResult = { email: "skip", slack: "skip" };
  const operator = (env.ALLOWED_EMAIL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (operator.length > 0) {
    const r = await deliverEmail(env, {
      to: operator,
      subject: `[${b.severity.toUpperCase()}] ${b.kind} — ${b.signature}`,
      title: b.summary,
      bodyHtml: `<p>${b.summary}</p><pre style="background:#0f1115;color:#aab3bf;padding:12px;border-radius:6px;overflow-x:auto">${escapeHtmlLocal(JSON.stringify(b.context, null, 2))}</pre>`,
    }).catch((e) => ({ ok: false, error: (e as Error).message }));
    result.email = r.ok ? "ok" : `err:${r.error ?? "unknown"}`.slice(0, 200);
  }
  const slackUrl = (env as unknown as { SLACK_WEBHOOK_URL?: string }).SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const res = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `*[${b.severity.toUpperCase()}] ${b.kind}* — ${b.summary}`,
          attachments: [{ text: "```" + JSON.stringify(b.context, null, 2) + "```", color: b.severity === "critical" ? "danger" : "warning" }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      result.slack = res.ok ? "ok" : `err:http_${res.status}`;
    } catch (e) {
      result.slack = `err:${(e as Error).message}`.slice(0, 200);
    }
  }
  return result;
}

function escapeHtmlLocal(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export interface RunAlertsResult {
  evaluated: number;
  opened: number;
  closed: number;
}

const RECOVER_KEY_PREFIX = "ops:health:recover:";
const RECOVER_TICKS_TO_CLOSE = 2;

export async function runAlertEvaluator(env: Env): Promise<RunAlertsResult> {
  const breaches = await evaluateBreaches(env);
  const breachBySig = new Map(breaches.map((b) => [b.signature, b]));
  let opened = 0;
  let closed = 0;

  // Capture a rich health snapshot ONCE when any incident is about to
  // open. Per the Task #4 static-routing constraint, the timeline page
  // must hydrate strictly from `context_json` captured at incident
  // open — never re-query the underlying gauge tables. We bundle the
  // current queue depths, compute-pool statuses, error rate, top error
  // signatures, and the breach payload itself so the incident detail
  // page has everything it needs locally.
  let snapshotContext: Record<string, unknown> | null = null;
  async function buildContextSnapshot(): Promise<Record<string, unknown>> {
    if (snapshotContext) return snapshotContext;
    const [queues, nodes, erate, d1, errs, extApis, crons] = await Promise.all([
      collectQueues(env).catch(() => []),
      collectComputePool(env).catch(() => []),
      collectErrorRatePerMin(env).catch(() => 0),
      collectD1(env).catch(() => ({ reads_per_sec_estimate: 0, writes_per_sec_estimate: 0, errors_24h: 0, throttled_24h: 0 })),
      collectRecentErrors(env, 20).catch(() => []),
      collectExternalApis(env, [...PROBE_NAMES]).catch(() => []),
      collectCronStatus(env).catch(() => []),
    ]);
    const versionId = (env as unknown as { CF_VERSION_METADATA?: { id?: string; timestamp?: string } }).CF_VERSION_METADATA;
    snapshotContext = {
      captured_at: new Date().toISOString(),
      queues, compute_pool: nodes, errors_per_min: erate,
      d1, top_errors: errs,
      external_apis: extApis,
      crons,
      deploy: {
        version_id: versionId?.id ?? null,
        deployed_at: versionId?.timestamp ?? null,
      },
    };
    return snapshotContext;
  }

  // 1) Open new incidents for breaches without an active row.
  for (const b of breaches) {
    const existing = await env.DB.prepare(
      `SELECT id FROM ops_incidents WHERE signature = ? AND closed_at IS NULL LIMIT 1`,
    ).bind(b.signature).first<{ id: string }>().catch(() => null);
    if (existing) continue;
    const id = "inc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const delivery = await notify(env, b);
    const snap = await buildContextSnapshot();
    const fullContext = { ...b.context, snapshot: snap, breach: b };
    // `OR IGNORE` cooperates with the partial unique index
    // `uq_ops_incidents_open_signature` to make the insert atomic
    // against concurrent evaluator ticks: a second tick that lost the
    // race becomes a no-op (changes=0) instead of throwing a
    // constraint error.
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO ops_incidents (id, severity, kind, signature, summary, context_json, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      b.severity,
      b.kind,
      b.signature,
      b.summary,
      JSON.stringify(fullContext),
      `email:${delivery.email},slack:${delivery.slack}`,
    ).run().catch((e) => {
      console.warn("ops_incidents insert failed", (e as Error).message);
      return null;
    });
    // Count only successful inserts — `OR IGNORE` resolves the
    // concurrent-evaluator race silently (changes=0); we must not
    // claim we opened an incident we didn't.
    if (ins && (ins.meta?.changes ?? 0) > 0) opened++;
  }

  // 2) Close incidents whose signature is no longer breached for
  //    RECOVER_TICKS_TO_CLOSE consecutive evaluations. Recovery
  //    counter lives in KV so it survives without a new table.
  const open = await env.DB.prepare(
    `SELECT id, signature FROM ops_incidents WHERE closed_at IS NULL`,
  ).all<{ id: string; signature: string }>().catch(() => ({ results: [] as Array<{ id: string; signature: string }> }));
  for (const inc of open.results ?? []) {
    if (breachBySig.has(inc.signature)) {
      // Still breached — reset the recovery counter.
      try { await env.SESSIONS?.delete(RECOVER_KEY_PREFIX + inc.signature); } catch { /* ignore */ }
      continue;
    }
    let ticks = 0;
    try {
      const v = await env.SESSIONS?.get(RECOVER_KEY_PREFIX + inc.signature);
      ticks = v ? Number(v) : 0;
    } catch { /* ignore */ }
    ticks++;
    if (ticks >= RECOVER_TICKS_TO_CLOSE) {
      await env.DB.prepare(
        `UPDATE ops_incidents
            SET closed_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ?`,
      ).bind(inc.id).run().catch(() => undefined);
      try { await env.SESSIONS?.delete(RECOVER_KEY_PREFIX + inc.signature); } catch { /* ignore */ }
      closed++;
    } else {
      try { await env.SESSIONS?.put(RECOVER_KEY_PREFIX + inc.signature, String(ticks), { expirationTtl: 60 * 60 * 24 }); } catch { /* ignore */ }
    }
  }

  return { evaluated: breaches.length, opened, closed };
}

// Expose for tests.
export const _testing = {
  nodeStatus,
  RECOVER_KEY_PREFIX,
  RECOVER_TICKS_TO_CLOSE,
};
