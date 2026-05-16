import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cors } from "hono/cors";
import type { Env, JobMessage, QueueMessage } from "./types";
import { entitiesRoute } from "./routes/entities";
import { isRebuildSummaryMessage, handleSummaryMessage } from "./entities/summaryQueue";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { analytics } from "./routes/analytics";
import { analyticsV2 } from "./routes/analytics_v2";
import { leads } from "./routes/leads";
import { exports_ } from "./routes/exports";
import { jobs } from "./routes/jobs";
import { dedupe } from "./routes/dedupe";
import { scrapers } from "./routes/scrapers";
import { discover } from "./routes/discover";
import { enrichment, leadsEnrichActions } from "./routes/enrichment";
import { taxonomies } from "./routes/taxonomies";
import { icp } from "./routes/icp";
import { compliance, complianceDncAlias, complianceAuditAlias, gdpr, leadsDncActions } from "./routes/compliance";
import { campaigns, campaignsWebhook, leadsCampaignActions } from "./routes/campaigns";
import { firms } from "./routes/firms";
import { imports } from "./routes/imports";
import { sources } from "./routes/sources";
import { savedFilters } from "./routes/saved_filters";
import { analyticsFirms } from "./routes/analytics_firms";
import { relationships } from "./routes/relationships";
import { uploads } from "./routes/uploads";
import { investors } from "./routes/investors";
import { companies } from "./routes/companies";
import { search } from "./routes/search";
import { aiAnalytics } from "./routes/analytics_ae";
import { accountsRoute, buyersRoute, signalsRoute } from "./routes/prospects";
import { crawlersRoute } from "./routes/crawlers";
import { personasRoute } from "./routes/personas";
import { projectsRoute } from "./routes/projects";
import { ddRoute } from "./routes/dd";
import { newsRoute, factsCitationsRoute } from "./routes/news";
export { EntityLock } from "./do/EntityLock";
export { EnrichLeadWorkflow, EnrichFirmWorkflow, IngestPageWorkflow, EnrichAccountWorkflow, CrawlSignalsWorkflow, RescorePersonaWorkflow, MatchProjectWorkflow, DDScanEntityWorkflow, DDScanBatchWorkflow, RefreshNewsWorkflow } from "./ai/workflows";
import { piiAuditOnLeadGet } from "./middleware/pii_audit";
import { accessGuard } from "./middleware/access";
import { requestId } from "./middleware/request_id";
import { runJob } from "./scraper/pipeline";
import { scheduled as scheduledHandler } from "./scheduled";
import { errors as errorsRoute } from "./routes/errors";
import { admin, sweepStuckJobs } from "./routes/admin";
import { AppError, wrapUnknown } from "./errors";
import { logError } from "./db/error_log";

const API_HOST = "api.aidatasignal.com";

const api = new Hono<{ Bindings: Env; Variables: { email: string; request_id: string } }>();

api.use("*", requestId);

api.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = new Set([
        "https://aidatasignal.com",
        "https://www.aidatasignal.com",
      ]);
      if (origin && allowed.has(origin)) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Cf-Access-Jwt-Assertion"],
  }),
);

// Public liveness only — `/health` returns the cheap DB ping (no binding
// inventory). The deep readiness probe (`/api/health/deep`) is mounted
// after `accessGuard` below so its operational telemetry is not exposed.
api.route("/health", health);
// Public webhook (HMAC-signed) — must be mounted *before* accessGuard so
// marketing tools can post events without a Cloudflare Access cookie.
api.route("/api/campaigns", campaignsWebhook);
api.use("/api/*", accessGuard);
api.route("/api/health", health);
// PII access audit — runs after the lead-detail handler.
api.use("/api/leads/:id", piiAuditOnLeadGet);
api.route("/api/auth", auth);
api.route("/api/analytics", analytics);
api.route("/api/analytics", analyticsV2);
api.route("/api/leads", leads);
api.route("/api/exports", exports_);
api.route("/api/jobs", jobs);
api.route("/api/dedupe", dedupe);
api.route("/api/scrapers", scrapers);
api.route("/api/discover", discover);
api.route("/api/enrichment", enrichment);
api.route("/api/taxonomies", taxonomies);
api.route("/api/icp", icp);
api.route("/api/compliance", compliance);
// Backward-compatible aliases per task spec: /api/dnc/* and /api/audit/pii.
api.route("/api/dnc", complianceDncAlias);
api.route("/api/audit", complianceAuditAlias);
api.route("/api/gdpr", gdpr);
api.route("/api/campaigns", campaigns);
api.route("/api/firms", firms);
api.route("/api/import", imports);
api.route("/api/imports", imports);
// Task #5: source registry (CRUD + run + run-all + preview + bootstrap).
api.route("/api/sources", sources);
api.route("/api/saved-filters", savedFilters);
api.route("/api/analytics/firms", analyticsFirms);
api.route("/api/relationships", relationships);
api.route("/api/uploads", uploads);
api.route("/api/investors", investors);
api.route("/api/companies", companies);
api.route("/api/search", search);
api.route("/api/analytics/ae", aiAnalytics);
// Task #44: prospect database (accounts/buyers/signals).
api.route("/api/accounts", accountsRoute);
api.route("/api/buyers", buyersRoute);
api.route("/api/signals", signalsRoute);
// Task #45: buyer-signal crawler admin.
api.route("/api/crawlers", crawlersRoute);
// Task #46: persona profiler.
api.route("/api/personas", personasRoute);
// Task #47: projects (multi-audience matching workspace).
api.route("/api/projects", projectsRoute);
// Task #4: unified entity graph (additive — legacy reads keep working).
api.route("/api/entities", entitiesRoute);
api.route("/api/dd", ddRoute);
// Task #2: news ingestion + citations + fact verification.
api.route("/api/news", newsRoute);
api.route("/api/facts", factsCitationsRoute);
// /api/leads/:id/enrich, /api/leads/enrich/bulk, /:id/dnc, /:id/campaigns
api.route("/api/leads", leadsEnrichActions);
api.route("/api/leads", leadsDncActions);
api.route("/api/leads", leadsCampaignActions);
api.route("/api/errors", errorsRoute);
// Task #2: operational admin endpoints (sweep stuck jobs, repair pipeline,
// rebuild summary, queue-health roll-up).
api.route("/api/admin", admin);

api.notFound((c) => c.json({ error: "not_found", request_id: c.var.request_id }, 404));
api.onError((err, c) => {
  const appErr = err instanceof AppError ? err : wrapUnknown(err, "internal_error");
  const requestIdVal = c.var.request_id;
  // Fire-and-forget log; never block the response on logging.
  c.executionCtx.waitUntil(
    logError(c.env, {
      err: appErr,
      request_id: requestIdVal,
      url: c.req.url,
      method: c.req.method,
    }).then(() => undefined).catch(() => undefined),
  );
  if (appErr.kind === "internal" || appErr.status >= 500) {
    console.error("Worker error", appErr.code, appErr.message, appErr.cause?.stack ?? "");
  } else {
    console.warn("Worker error", appErr.code, appErr.message);
  }
  return c.json(appErr.toJSON(requestIdVal), appErr.status as ContentfulStatusCode);
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (host === API_HOST) return api.fetch(req, env, ctx);
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    // Task #2: opportunistic stuck-job sweep at the head of every batch.
    // Cheap (one indexed UPDATE) and guarantees we never let a job sit
    // in `running` past its budget even when the queue is otherwise idle.
    const batchStartedAt = Date.now();
    const batchSize = batch.messages.length;
    let batchSwept = 0;
    let batchAcked = 0;
    let batchRetried = 0;
    let batchDeadLettered = 0;
    let batchFailed = 0;
    try {
      batchSwept = await sweepStuckJobs(env);
    } catch (e) {
      console.warn("sweepStuckJobs failed", (e as Error).message);
    }
    const batchAttempts = batch.messages.map((m) => ({ msg_id: m.id, attempts: m.attempts }));
    console.log("queue.batch_begin", JSON.stringify({ size: batchSize, swept: batchSwept, attempts: batchAttempts }));
    // Task #2: wrap the message loop in try/finally so that
    // queue.batch_end telemetry is emitted even if an unexpected
    // uncaught error escapes the per-message try/catch above.
    try {
    for (const msg of batch.messages) {
      const body = msg.body as QueueMessage | undefined;
      // Task #4: dispatch the new summary-rebuild envelope before the legacy
      // JobMessage validation kicks in.
      if (isRebuildSummaryMessage(body)) {
        const stepStart = Date.now();
        try {
          await handleSummaryMessage(env, body);
          msg.ack();
          batchAcked++;
          console.log("queue.step_end", JSON.stringify({ step: "rebuild_summary", msg_id: msg.id, ms: Date.now() - stepStart, ok: true }));
        } catch (e) {
          const appErr = e instanceof AppError ? e : wrapUnknown(e, "queue_run_failed", { msgId: msg.id, op: "rebuild_summary" });
          await logError(env, { err: appErr, step: "queue.rebuildSummary", retry_count: msg.attempts });
          console.log("queue.step_end", JSON.stringify({ step: "rebuild_summary", msg_id: msg.id, ms: Date.now() - stepStart, ok: false, error_code: appErr.code }));
          if (msg.attempts < 3) { msg.retry({ delaySeconds: 30 * Math.pow(2, msg.attempts) }); batchRetried++; }
          else { msg.ack(); batchAcked++; batchFailed++; }
        }
        continue;
      }
      const legacy = body as JobMessage | undefined;
      const jobId = legacy && typeof legacy === "object" && "jobId" in legacy ? String((legacy as { jobId: unknown }).jobId) : null;
      const stepStart = Date.now();
      try {
        if (!legacy || typeof legacy !== "object" || !("jobId" in legacy) || !("kind" in legacy) || !("target" in legacy)) {
          console.warn("Skipping malformed queue message", msg.id);
          await logError(env, {
            err: new AppError({ code: "queue_malformed", kind: "validation", message: "malformed queue message", context: { msgId: msg.id } }),
          });
          msg.ack();
          batchAcked++;
          continue;
        }
        await runJob(legacy, env);
        msg.ack();
        batchAcked++;
        console.log("queue.step_end", JSON.stringify({ step: "runJob", msg_id: msg.id, job_id: jobId, ms: Date.now() - stepStart, ok: true }));
      } catch (e) {
        const appErr = e instanceof AppError ? e : wrapUnknown(e, "queue_run_failed", { msgId: msg.id, jobId });
        const attempts = msg.attempts;
        await logError(env, { err: appErr, job_id: jobId, step: "queue.runJob", retry_count: attempts });
        const transient = appErr.retryable;
        const now = new Date().toISOString();
        // Task #2: cap retries at 3 (was 5) before dead-lettering.
        if (transient && attempts < 3) {
          console.warn("Queue retry (transient)", msg.id, appErr.code, appErr.message);
          if (jobId) {
            try {
              await env.DB.prepare(
                `UPDATE jobs SET retry_count = ?, last_error_code = ?, last_error_at = ? WHERE id = ?`,
              ).bind(attempts, appErr.code, now, jobId).run();
            } catch { /* ignore */ }
          }
          msg.retry({ delaySeconds: Math.min(30 * Math.pow(2, attempts), 600) });
          batchRetried++;
          console.log("queue.step_end", JSON.stringify({ step: "runJob", msg_id: msg.id, job_id: jobId, ms: Date.now() - stepStart, ok: false, retry: true, error_code: appErr.code }));
        } else {
          // Task #2: attempts >= 3 transitions the job to dead_letter; otherwise failed.
          const finalState = attempts >= 3 ? "dead_letter" : "failed";
          if (finalState === "dead_letter") batchDeadLettered++; else batchFailed++;
          console.error("Queue ack (permanent)", msg.id, finalState, appErr.code, appErr.message);
          if (jobId) {
            try {
              // Task #2: guard against clobbering terminal states set by
              // the sweeper or operator (timed_out / cancelled /
              // dead_letter). Mirrors the same guard in pipeline.markFailed.
              await env.DB.prepare(
                `UPDATE jobs SET status = ?, retry_count = ?, last_error_code = ?, last_error_at = ?, finished_at = COALESCE(finished_at, ?)
                  WHERE id = ? AND status IN ('queued','running')`,
              ).bind(finalState, attempts, appErr.code, now, now, jobId).run();
              await env.DB.prepare(
                `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by) VALUES (?, NULL, ?, ?, 'queue')`,
              ).bind(jobId, finalState, appErr.code).run();
            } catch { /* ignore */ }
          }
          msg.ack();
          batchAcked++;
          console.log("queue.step_end", JSON.stringify({ step: "runJob", msg_id: msg.id, job_id: jobId, ms: Date.now() - stepStart, ok: false, final_state: finalState, error_code: appErr.code }));
        }
      }
    }
    } finally {
      console.log("queue.batch_end", JSON.stringify({
        size: batchSize, swept: batchSwept, acked: batchAcked, retried: batchRetried,
        failed: batchFailed, dead_lettered: batchDeadLettered, ms: Date.now() - batchStartedAt,
      }));
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledHandler(event, env, ctx);
  },
};
