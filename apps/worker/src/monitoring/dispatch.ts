// Per-entity monitoring dispatcher.
//
// Pipeline:
//   1. Build canonical summary, compare hash to latest snapshot.
//   2. If unchanged AND same schema_version → no-op (fingerprint-first).
//   3. Persist the new snapshot.
//   4. For every active rule attached to (entity, OR watchlist containing
//      entity), run the trigger evaluator. Skip rules whose
//      schema_version differs from a hot baseline (storm avoidance).
//   5. For each emitted event:
//        a. Compute dedupe hash; if matching recent row inside window
//           → write 'suppressed_duplicate' row and continue.
//        b. Otherwise insert pending event row, then dispatch by
//           channel (or enqueue into digest_queue when frequency != realtime).

import type { Env } from "../types";
import { buildCanonicalSummary, fingerprintSummary, loadLatestSnapshot, persistSnapshot, sha256Hex, SUMMARY_SCHEMA_VERSION } from "./summary";
import { diffSummaries } from "./diff";
import { evaluate, SOURCE_DRIVEN_TRIGGERS } from "./triggers/index";
import type { AlertRuleRow, EvalContext, EvaluatedAlert, TriggerKind } from "./types";
import { deliverInApp } from "./channels/inApp";
import { deliverEmail } from "./channels/email";
import { deliverSlack } from "./channels/slack";
import { deliverWebhook } from "./channels/webhook";
import { computeDigestScheduledFor, loadDigestPrefs } from "./schedule";

// Spec: webhook retries continue for up to 6 hours from first attempt.
const WEBHOOK_RETRY_HORIZON_MS = 6 * 60 * 60 * 1000;

interface MonitorResult {
  entityId: string;
  changed: boolean;
  schemaBaselined: boolean;
  evaluated: number;
  emitted: number;
  suppressed: number;
  delivered: number;
}

export async function monitorEntity(env: Env, entityId: string): Promise<MonitorResult> {
  const result: MonitorResult = {
    entityId, changed: false, schemaBaselined: false,
    evaluated: 0, emitted: 0, suppressed: 0, delivered: 0,
  };
  const newSummary = await buildCanonicalSummary(env, entityId);
  if (!newSummary) return result;
  const newHash = await fingerprintSummary(newSummary);
  const last = await loadLatestSnapshot(env, entityId);

  // Capture the prior watermark BEFORE stamping a new one — this is the
  // source-table cutoff source-driven evaluators filter against.
  const prior = await env.DB.prepare(
    `SELECT last_evaluated_at FROM entity_monitor_state WHERE entity_id = ?`,
  ).bind(entityId).first<{ last_evaluated_at: string | null }>();
  const sinceWatermark = prior?.last_evaluated_at ?? null;
  const tickStartedAt = new Date().toISOString();

  // Watermark is stamped AFTER evaluation/dispatch completes (see end of
  // function). Stamping pre-evaluation would skip source-driven events on
  // partial failures, since the next tick would advance `sinceWatermark`
  // past the un-dispatched window.

  const fingerprintChanged = !last || last.hash !== newHash;
  const schemaBumped = !!last && last.schema_version !== newSummary.schema_version;

  // Schema bump → persist a fresh baseline, skip evaluation this tick.
  if (schemaBumped) {
    await persistSnapshot(env, entityId, newSummary, newHash);
    result.schemaBaselined = true;
    result.changed = true;
    await stampWatermark(env, entityId, tickStartedAt, newHash);
    return result;
  }

  if (fingerprintChanged) {
    await persistSnapshot(env, entityId, newSummary, newHash);
    result.changed = true;
  }

  const diff = fingerprintChanged ? diffSummaries(last?.summary ?? null, newSummary) : [];
  // Baseline (no prior snapshot) → store but emit nothing (spec). We MUST
  // stamp the watermark here so the next tick's source-driven evaluators
  // see a non-null `sinceWatermark` and don't backfill historical rows
  // (relationships, predictions, posts, news, investments) as new events.
  if (!last) {
    await stampWatermark(env, entityId, tickStartedAt, newHash);
    return result;
  }

  // Load matching active rules: directly attached OR via a watchlist
  // the entity belongs to. Dedupe by rule id.
  const ruleRows = await env.DB.prepare(
    `SELECT r.id, r.owner_email, r.name, r.watchlist_id, r.entity_id, r.trigger_kind,
            r.trigger_config_json, r.channel, r.channel_config_json, r.digest_frequency,
            r.dedupe_window_seconds, r.is_active, r.last_fired_at, r.fire_count
       FROM alert_rules r
      WHERE r.is_active = 1
        AND (r.entity_id = ?
             OR r.watchlist_id IN (SELECT watchlist_id FROM watchlist_members WHERE entity_id = ?))`,
  ).bind(entityId, entityId).all<AlertRuleRow>();
  const allRules = ruleRows.results ?? [];

  // When the canonical summary fingerprint hasn't moved, skip
  // summary-driven evaluators (their inputs literally didn't change) but
  // still run source-driven ones — relationships, predictions, posts,
  // funding, news, investments live in their own tables and may have
  // moved independently.
  const rules = fingerprintChanged
    ? allRules
    : allRules.filter((r) => SOURCE_DRIVEN_TRIGGERS.has(r.trigger_kind as TriggerKind));

  for (const rule of rules) {
    result.evaluated++;
    const cfg = parseJson<Record<string, unknown>>(rule.trigger_config_json) ?? {};
    const ctx: EvalContext = {
      env, entityId, ownerEmail: rule.owner_email,
      oldSummary: last?.summary ?? null, newSummary, diff, ruleConfig: cfg,
      sinceWatermark,
    };
    const evt = await evaluate(rule.trigger_kind as TriggerKind, ctx);
    if (!evt) continue;
    const dispatched = await dispatchEvent(env, rule, evt, entityId);
    result.emitted++;
    if (dispatched === "suppressed") result.suppressed++;
    else if (dispatched === "delivered") result.delivered++;
  }
  // Two-phase watermark: only advance once evaluation+dispatch completes.
  // We anchor at tickStartedAt (not "now") so any source-table rows
  // inserted DURING this tick are still picked up by the next one.
  await stampWatermark(env, entityId, tickStartedAt, newHash);
  return result;
}

async function stampWatermark(env: Env, entityId: string, ts: string, hash: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO entity_monitor_state (entity_id, last_evaluated_at, last_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET last_evaluated_at=excluded.last_evaluated_at, last_hash=excluded.last_hash`,
  ).bind(entityId, ts, hash).run();
}

export type DispatchOutcome = "delivered" | "suppressed" | "pending" | "failed" | "digested";

export async function dispatchEvent(env: Env, rule: AlertRuleRow, evt: EvaluatedAlert, entityId: string): Promise<DispatchOutcome> {
  // 1. Dedupe check. The entity id is part of the hash so watchlist-scoped
  //    rules dedupe per-entity rather than collapsing across members.
  const hash = await sha256Hex(`${rule.id}|${entityId}|${rule.trigger_kind}|${evt.dedupe_key}`);
  const window = rule.dedupe_window_seconds ?? 3600;
  const cutoff = new Date(Date.now() - window * 1000).toISOString();
  const dup = await env.DB.prepare(
    // Dedupe suppression is independent of downstream delivery outcome:
    // once the (rule_id, entity_id, trigger_kind, dedupe_key) tuple has
    // been emitted within the window we don't re-emit, regardless of
    // whether the prior attempt is pending (retrying webhook), already
    // delivered, queued in a digest, or even failed/suppressed. The
    // dispatcher's own retry loop owns redelivery for pending/failed
    // rows; dedupe owns trigger-level idempotency. This prevents a
    // flaky destination from generating N duplicate event rows for the
    // same underlying change.
    `SELECT id FROM alert_events WHERE dedupe_hash = ? AND occurred_at > ? LIMIT 1`,
  ).bind(hash, cutoff).first<{ id: string }>();

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const entityForRule = entityId;

  if (dup) {
    await env.DB.prepare(
      `INSERT INTO alert_events (id, owner_email, rule_id, watchlist_id, entity_id, trigger_kind,
          dedupe_key, dedupe_hash, title, body, diff_json, payload_json, channel,
          delivery_status, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suppressed_duplicate', ?)`,
    ).bind(eventId, rule.owner_email, rule.id, rule.watchlist_id, entityForRule,
      rule.trigger_kind, evt.dedupe_key, hash, evt.title, evt.body,
      JSON.stringify(evt.diff), JSON.stringify(evt.payload), rule.channel, now).run();
    return "suppressed";
  }

  await env.DB.prepare(
    `INSERT INTO alert_events (id, owner_email, rule_id, watchlist_id, entity_id, trigger_kind,
        dedupe_key, dedupe_hash, title, body, diff_json, payload_json, channel,
        delivery_status, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(eventId, rule.owner_email, rule.id, rule.watchlist_id, entityForRule,
    rule.trigger_kind, evt.dedupe_key, hash, evt.title, evt.body,
    JSON.stringify(evt.diff), JSON.stringify(evt.payload), rule.channel, now).run();

  await env.DB.prepare(
    `UPDATE alert_rules SET last_fired_at = ?, fire_count = fire_count + 1, updated_at = ? WHERE id = ?`,
  ).bind(now, now, rule.id).run();

  // Digest routing: short-circuit channel delivery, enqueue the event.
  if (rule.digest_frequency !== "realtime" && rule.digest_frequency !== "off"
      && rule.channel !== "in_app" /* in-app is always realtime */) {
    const prefs = await loadDigestPrefs(env, rule.owner_email);
    const scheduled = computeDigestScheduledFor(rule.digest_frequency, prefs);
    await env.DB.prepare(
      `INSERT INTO digest_queue (id, owner_email, watchlist_id, event_id, scheduled_for, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).bind(crypto.randomUUID(), rule.owner_email, rule.watchlist_id, eventId, scheduled).run();
    await env.DB.prepare(`UPDATE alert_events SET delivery_status='digested' WHERE id = ?`).bind(eventId).run();
    return "digested";
  }

  return await deliverEvent(env, eventId, rule, evt, { entityId: entityForRule, occurredAt: now });
}

interface DeliverContext { entityId: string; occurredAt: string }

export async function deliverEvent(env: Env, eventId: string, rule: AlertRuleRow, evt: EvaluatedAlert, dctx: DeliverContext): Promise<DispatchOutcome> {
  const channelCfg = parseJson<Record<string, unknown>>(rule.channel_config_json) ?? {};
  // Structured delivery attempt log. Each row carries the channel,
  // outcome status, an HTTP-style status_code when the channel produced
  // one (email/slack/webhook), a coarse error_class for grouping
  // (network|http_4xx|http_5xx|config|none), and the freeform message.
  const log: Array<{
    ts: string; channel: string; status: string;
    status_code?: number; error_class?: string; error?: string;
  }> = [];
  const now = () => new Date().toISOString();
  // Classify an error string + optional HTTP status into a coarse bucket
  // so operators can filter "all 5xx vs network vs config" without
  // re-parsing message text.
  function classify(err: string | undefined, status: number | undefined): string {
    if (!err) return "none";
    if (typeof status === "number") {
      if (status >= 500) return "http_5xx";
      if (status === 429 || status === 408) return "http_retryable";
      if (status >= 400) return "http_4xx";
    }
    if (/_network:|network|fetch failed|ECONN|ETIMEDOUT/i.test(err)) return "network";
    if (/missing_|bad_url|no_recipients|bad_slack_url|rate_limited/i.test(err)) return "config";
    return "other";
  }
  let ok = false;
  let retryable = false;
  let lastErr: string | undefined;
  let lastStatus: number | undefined;

  switch (rule.channel) {
    case "in_app": {
      const r = await deliverInApp(env, eventId);
      ok = r.ok; lastErr = r.error; lastStatus = undefined;
      log.push({ ts: now(), channel: "in_app", status: ok ? "ok" : "error",
        error_class: classify(r.error, undefined), error: r.error });
      break;
    }
    case "email": {
      const to = Array.isArray(channelCfg.email) ? (channelCfg.email as string[]).filter((s) => typeof s === "string")
                 : typeof channelCfg.email === "string" ? [channelCfg.email] : [rule.owner_email];
      const r = await deliverEmail(env, {
        to, subject: evt.title.slice(0, 200), title: evt.title,
        bodyHtml: `<p>${escapeHtml(evt.body).replace(/\n/g, "<br>")}</p>`,
        entityLink: `https://aidatasignal.com/dashboard/profile/?entity=${encodeURIComponent(dctx.entityId)}`,
      });
      ok = r.ok; lastErr = r.error; lastStatus = r.status;
      log.push({ ts: now(), channel: "email", status: ok ? "ok" : "error",
        status_code: r.status, error_class: classify(r.error, r.status), error: r.error });
      break;
    }
    case "slack": {
      const url = String(channelCfg.slack_url ?? channelCfg.webhook_url ?? "");
      const entityName = String(evt.title.split(":")[0] ?? dctx.entityId);
      const r = await deliverSlack(env, {
        webhookUrl: url, title: evt.title, entityName,
        entityUrl: `https://aidatasignal.com/dashboard/profile/?entity=${encodeURIComponent(dctx.entityId)}`,
        diff: evt.diff, body: evt.body,
      });
      ok = r.ok; lastErr = r.error; lastStatus = r.status;
      log.push({ ts: now(), channel: "slack", status: ok ? "ok" : "error",
        status_code: r.status, error_class: classify(r.error, r.status), error: r.error });
      break;
    }
    case "webhook": {
      const url = String(channelCfg.webhook_url ?? "");
      const secret = String(channelCfg.webhook_secret ?? "");
      if (!url || !secret) { ok = false; lastErr = "missing_webhook_url_or_secret"; }
      else {
        // occurred_at is the original event timestamp so retries produce
        // a byte-identical body (stable HMAC + downstream idempotency).
        const r = await deliverWebhook(env, {
          url, secret,
          body: {
            event_id: eventId,
            rule_id: rule.id,
            entity_id: dctx.entityId,
            trigger_kind: rule.trigger_kind,
            occurred_at: dctx.occurredAt,
            title: evt.title,
            body: evt.body,
            diff: evt.diff,
            payload: evt.payload,
          },
        });
        ok = r.ok; lastErr = r.error; retryable = r.retryable; lastStatus = r.status;
      }
      log.push({ ts: now(), channel: "webhook", status: ok ? "ok" : "error",
        status_code: lastStatus, error_class: classify(lastErr, lastStatus), error: lastErr });
      break;
    }
    case "digest":
      // Shouldn't reach here — `digest` channel is routed via digest_queue.
      ok = true;
      log.push({ ts: now(), channel: "digest", status: "skipped" });
      break;
  }

  // Accumulate the delivery log so every attempt is preserved (audit trail).
  const existing = await env.DB.prepare(
    `SELECT delivery_attempts, delivery_log_json FROM alert_events WHERE id = ?`,
  ).bind(eventId).first<{ delivery_attempts: number; delivery_log_json: string | null }>();
  const prevLog = parseJson<Array<{
    ts: string; channel: string; status: string;
    status_code?: number; error_class?: string; error?: string;
  }>>(existing?.delivery_log_json ?? null) ?? [];
  const fullLog = prevLog.concat(log);
  const attempts = (existing?.delivery_attempts ?? 0) + 1;

  if (ok) {
    await env.DB.prepare(
      `UPDATE alert_events SET delivery_status='delivered', delivered_at=?,
         delivery_attempts=?, delivery_log_json=?, next_attempt_at=NULL WHERE id = ?`,
    ).bind(now(), attempts, JSON.stringify(fullLog), eventId).run();
    return "delivered";
  }
  // Failure path. Webhook with retryable (5xx/network) error → schedule
  // next attempt with exponential backoff, but only while we're still
  // inside the 6h retry horizon measured from the original event time.
  const ageMs = Date.now() - new Date(dctx.occurredAt).getTime();
  if (rule.channel === "webhook" && retryable && ageMs < WEBHOOK_RETRY_HORIZON_MS) {
    const backoffMs = Math.min(60 * 1000 * Math.pow(2, attempts), 60 * 60 * 1000);
    const cappedNext = Math.min(Date.now() + backoffMs,
      new Date(dctx.occurredAt).getTime() + WEBHOOK_RETRY_HORIZON_MS);
    const nextAttempt = new Date(cappedNext).toISOString();
    await env.DB.prepare(
      `UPDATE alert_events SET delivery_status='pending', delivery_attempts=?,
         next_attempt_at=?, delivery_log_json=? WHERE id = ?`,
    ).bind(attempts, nextAttempt, JSON.stringify(fullLog), eventId).run();
    return "pending";
  }
  await env.DB.prepare(
    `UPDATE alert_events SET delivery_status='failed', delivery_attempts=?,
       delivery_log_json=?, next_attempt_at=NULL WHERE id = ?`,
  ).bind(attempts, JSON.stringify(fullLog), eventId).run();
  return "failed";
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * Pending-event retry sweeper. Called from MonitorBatchWorkflow each tick.
 * Picks pending events whose next_attempt_at has come due and retries.
 *
 * OPERATIONAL NOTE: this sweeper runs on the shared hourly cron slot
 * (see scheduled.ts — Cloudflare free plan caps cron slots at 5 and
 * the existing `0 * * * *` slot is reused; we cannot register a
 * dedicated per-minute slot). The per-attempt exponential backoff
 * computed at failure time (1m, 2m, 4m, …) is therefore the LOWER
 * bound on retry latency — the actual retry executes on the next
 * hourly cron tick after next_attempt_at falls due. Operators should
 * communicate "webhook retries land within ~1h of becoming due" to
 * downstream consumers; the 6h horizon still applies end-to-end.
 */
export async function retryPendingDeliveries(env: Env, limit = 50): Promise<{ retried: number; delivered: number; failed: number }> {
  const out = { retried: 0, delivered: 0, failed: 0 };
  const rows = await env.DB.prepare(
    `SELECT id, rule_id, entity_id, occurred_at FROM alert_events
       WHERE delivery_status = 'pending'
         AND next_attempt_at IS NOT NULL
         AND datetime(next_attempt_at) <= datetime('now')
       ORDER BY next_attempt_at ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; rule_id: string; entity_id: string; occurred_at: string }>();
  for (const r of rows.results ?? []) {
    out.retried++;
    const rule = await env.DB.prepare(
      `SELECT * FROM alert_rules WHERE id = ?`,
    ).bind(r.rule_id).first<AlertRuleRow>();
    if (!rule) continue;
    const evt = await env.DB.prepare(
      `SELECT title, body, diff_json, payload_json FROM alert_events WHERE id = ?`,
    ).bind(r.id).first<{ title: string; body: string; diff_json: string; payload_json: string }>();
    if (!evt) continue;
    const out2 = await deliverEvent(env, r.id, rule, {
      dedupe_key: "",
      title: evt.title, body: evt.body,
      diff: parseJson<EvaluatedAlert["diff"]>(evt.diff_json) ?? [],
      payload: parseJson<EvaluatedAlert["payload"]>(evt.payload_json) ?? {},
    }, { entityId: r.entity_id, occurredAt: r.occurred_at });
    if (out2 === "delivered") out.delivered++;
    else if (out2 === "failed") out.failed++;
  }
  return out;
}

/**
 * Pick the next batch of entities due for evaluation. An entity is "due"
 * when (a) it is a member of an active watchlist or directly attached to
 * an active rule, AND (b) its last_evaluated_at is older than `staleMs`
 * (or has never been evaluated).
 *
 * Note (intentional): we INTENTIONALLY require an active rule (direct or
 * watchlist-mediated). A watched entity without any active rule produces
 * no events and would burn evaluation budget for no observer. Product
 * intent here is "rule-driven monitoring," not "always-on snapshots."
 * To change this to "every watched entity regardless of rules," drop the
 * `alert_rules` predicate from the inner OR.
 */
export async function pickDueEntities(env: Env, opts: { limit?: number; staleMinutes?: number } = {}): Promise<string[]> {
  const limit = opts.limit ?? 200;
  const staleMin = opts.staleMinutes ?? 15;
  const r = await env.DB.prepare(
    `SELECT DISTINCT e.id AS id
       FROM u_entities e
       LEFT JOIN entity_monitor_state s ON s.entity_id = e.id
      WHERE e.status = 'active'
        AND (
          e.id IN (SELECT entity_id FROM alert_rules WHERE is_active = 1 AND entity_id IS NOT NULL)
          OR e.id IN (SELECT entity_id FROM watchlist_members WHERE watchlist_id IN
                       (SELECT DISTINCT watchlist_id FROM alert_rules WHERE is_active = 1 AND watchlist_id IS NOT NULL))
        )
        AND (s.last_evaluated_at IS NULL
             OR datetime(s.last_evaluated_at) < datetime('now', '-' || ? || ' minutes'))
      ORDER BY s.last_evaluated_at IS NULL DESC, s.last_evaluated_at ASC
      LIMIT ?`,
  ).bind(staleMin, limit).all<{ id: string }>();
  return (r.results ?? []).map((x) => x.id);
}

// Re-export so external callers don't depend on internal layout.
export { SUMMARY_SCHEMA_VERSION };
