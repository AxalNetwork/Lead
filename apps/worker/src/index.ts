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
import { discoveryRoute } from "./routes/discovery";
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
import { uploadsCsv } from "./routes/uploads_csv";
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
import { profileRoute } from "./routes/profile";
import {
  companiesPreferredStackRoute,
  investorsTermAggressivenessRoute,
  termBenchmarksRoute,
  termLeaksRoute,
} from "./routes/preferred_stack";
import { agent as agentRoute } from "./routes/agent";
import { watchlists as watchlistsRoute } from "./routes/watchlists";
import { alerts as alertsRoute } from "./routes/alerts";
import { osint as osintRoute } from "./routes/osint";
import { profilers as profilersRoute } from "./routes/profilers";
import { profileComments as profileCommentsRoute } from "./routes/profile_comments";
import { opsCrawlerRoute } from "./routes/ops_crawler";
import { opsGarbageRoute } from "./routes/ops_garbage";
import { opsComputeNodesRoute } from "./routes/ops_compute_nodes";
import { opsSystemHealthRoute } from "./routes/ops_system_health";
import { opsQualityRoute } from "./routes/ops_quality";
import { computeRunnerRoute } from "./routes/compute";
import { peopleRoute } from "./routes/people";
import { leadsPromote } from "./routes/leads_promote";
import { bulk } from "./routes/bulk";
import { profileTypesRoute } from "./routes/profile_types";
import { crawlerRoute } from "./routes/crawler";
import { crawlerSeedsRoute, crawlFrontierRoute } from "./routes/crawler_seeds";
import { vcSourcesRoute } from "./routes/vc_sources";
import { lpsRoute, fundsLpRoute, firmsLpRoute } from "./routes/lps";
import { dealsRoute, companiesDealsRoute, investorsDealsRoute } from "./routes/deals";
import { movementsRoute, peopleMovementsRoute, firmsMovementsRoute } from "./routes/movements";
import { fundsRoute, firmsFundsRoute } from "./routes/funds";
import { fundReturnsRoute } from "./routes/fund_returns";
import { influenceRoute } from "./routes/influence";
import { introsRoute } from "./routes/intros";
import { predictionsRoute } from "./routes/predictions";
import { angelsRoute, syndicatesRoute } from "./routes/angels";
import { dashboards as dashboardsRoute } from "./routes/dashboards";
import { capTableRoute } from "./routes/cap_table";
import { valuationCompaniesRoute, compPanelsRoute } from "./routes/valuation";
import { documentsRoute } from "./routes/documents";
import { dataRoomsRoute } from "./routes/data_rooms";
import { personsVerificationRoute } from "./routes/verification";
import { diligenceRoute } from "./routes/diligence";
import { founderCrmRoute } from "./routes/founder_crm";
import { mlRoute } from "./routes/ml";
// Task #3: Editable Profiles + Manual Overrides with Audit.
import { overridesRoute } from "./routes/overrides";
export { EntityLock } from "./do/EntityLock";
export { HostThrottle } from "./do/HostThrottle";
export { EnrichLeadWorkflow, EnrichFirmWorkflow, IngestPageWorkflow, EnrichAccountWorkflow, CrawlSignalsWorkflow, RescorePersonaWorkflow, PersonaEntityMatchWorkflow, PersonaMatchRefreshWorkflow, PersonaMatchEntityWorkflow, MatchProjectWorkflow, DDScanEntityWorkflow, DDScanBatchWorkflow, RefreshNewsWorkflow, ClassifyEntityWorkflow, ClassifyBatchWorkflow, AIProfileFillerWorkflow, AIProfileFillerBatchWorkflow, RefreshGovernmentWorkflow, DiscoverFromSeedWorkflow, CrawlFrontierWorkflow, MonitorEntityWorkflow, MonitorBatchWorkflow, DigestWorkflow, IndividualProfilerWorkflow } from "./ai/workflows";
export { CsvImportWorkflow } from "./imports/csv_import_workflow";
export { OSINTResolveEntityWorkflow, OSINTBatchWorkflow, OSINTReverifyWorkflow } from "./osint/workflows";
export { RefreshSavedResearchWorkflow } from "./agent/workflow";
import { piiAuditOnLeadGet } from "./middleware/pii_audit";
import { accessGuard, adminOnly } from "./middleware/access";
import { requestId } from "./middleware/request_id";
import { runJob } from "./scraper/pipeline";
import { scheduled as scheduledHandler } from "./scheduled";
import { errors as errorsRoute } from "./routes/errors";
import { admin, sweepStuckJobs } from "./routes/admin";
import { AppError, wrapUnknown } from "./errors";
import { logError } from "./db/error_log";

const API_HOST = "api.aidatasignal.com";

const api = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean; request_id: string } }>();

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
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Cf-Access-Jwt-Assertion", "Idempotency-Key"],
  }),
);
api.route("/health", health);
api.route("/api/health", health);
api.route("/api/webhooks/campaigns", campaignsWebhook);
// Task #9: Runner-facing compute endpoints authenticate via per-node
// HMAC envelope, NOT the Cloudflare Access JWT — mount BEFORE the
// /api/* accessGuard so external runners (non-browser clients) can
// reach /api/compute/* without an Access cookie.
api.route("/api/compute", computeRunnerRoute);
api.use("/api/*", accessGuard);
api.use("/api/ops/*", adminOnly);
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
api.route("/api/discovery", discoveryRoute);
api.route("/api/enrichment", enrichment);
api.route("/api/taxonomies", taxonomies);
api.route("/api/icp", icp);
api.route("/api/compliance", compliance);
api.route("/api/dnc", complianceDncAlias);
api.route("/api/audit", complianceAuditAlias);
api.route("/api/gdpr", gdpr);
api.route("/api/campaigns", campaigns);
api.route("/api/firms", firms);
api.route("/api/import", imports);
api.route("/api/imports", imports);
api.route("/api/sources", sources);
api.route("/api/saved-filters", savedFilters);
api.route("/api/analytics/firms", analyticsFirms);
api.route("/api/relationships", relationships);
api.route("/api/uploads/csv", uploadsCsv);
api.route("/api/uploads", uploads);
api.route("/api/investors", investors);
api.route("/api/companies", companies);
api.route("/api/search", search);
api.route("/api/analytics/ae", aiAnalytics);
api.route("/api/accounts", accountsRoute);
api.route("/api/buyers", buyersRoute);
api.route("/api/signals", signalsRoute);
api.route("/api/crawlers", crawlersRoute);
api.route("/api/personas", personasRoute);
api.route("/api/projects", projectsRoute);
// Task #3 (Editable Profiles): overridesRoute mounts BEFORE entitiesRoute
// so the new operator-driven /api/entities/:id/merge handler (which
// takes target_entity_id + writes an audit-log row) wins over the
// legacy pickPrimary /merge handler defined on entitiesRoute. Hono
// dispatches first-match, so order matters.
api.route("/api", overridesRoute);
api.route("/api/entities", entitiesRoute);
api.route("/api/dd", ddRoute);
api.route("/api/news", newsRoute);
api.route("/api/facts", factsCitationsRoute);
api.route("/api/profile", profileRoute);
api.route("/api/agent", agentRoute);
api.route("/api/watchlists", watchlistsRoute);
api.route("/api/alerts", alertsRoute);
api.route("/api/osint", osintRoute);
api.route("/api/profilers", profilersRoute);
api.route("/api/profile-comments", profileCommentsRoute);
api.route("/api/ops/crawler", opsCrawlerRoute);
// Task #9: External Worker Pool admin console.
api.route("/api/ops/compute-nodes", opsComputeNodesRoute);
// Task #5: System Health & Errors Dashboard. Admin-only via the parent
// /api/ops/* mount; aggregator + incidents + external API probes.
api.route("/api/ops/system-health", opsSystemHealthRoute);
// Task #6 (Comprehensive Bug Sweep) — Section N: Quality Console rollup.
api.route("/api/ops/quality", opsQualityRoute);
// Task #1: Garbage entity review console (admin-only via the
// /api/ops/* parent mount above).
api.route("/api/ops/garbage-review", opsGarbageRoute);
// Task #2 (People page): list-mode API.
api.route("/api/people", peopleRoute);
// Task #2 (Leads unification): bulk promote endpoint. Mounted under
// /api/leads so accessGuard applies and the path matches the spec.
api.route("/api/leads", leadsPromote);
api.route("/api/leads", leadsEnrichActions);
api.route("/api/leads", leadsDncActions);
api.route("/api/leads", leadsCampaignActions);
api.route("/api/errors", errorsRoute);
api.route("/api/admin", admin);
api.route("/api/bulk", bulk);
api.route("/api/profile-types", profileTypesRoute);
api.route("/api/crawler", crawlerRoute);
api.route("/api/crawler-seeds", crawlerSeedsRoute);
api.route("/api/crawl-frontier", crawlFrontierRoute);
api.route("/api/vc-sources", vcSourcesRoute);
api.route("/api/lps", lpsRoute);
api.route("/api/funds", fundsLpRoute);
api.route("/api/firms", firmsLpRoute);
api.route("/api/deals", dealsRoute);
api.route("/api/companies", companiesDealsRoute);
api.route("/api/investors", investorsDealsRoute);
api.route("/api/movements", movementsRoute);
api.route("/api/people", peopleMovementsRoute);
api.route("/api/firms", firmsMovementsRoute);
api.route("/api/funds", fundReturnsRoute);
api.route("/api/funds", fundsRoute);
api.route("/api/firms", firmsFundsRoute);
api.route("/api/angels", angelsRoute);
api.route("/api/syndicates", syndicatesRoute);
api.route("/api/dashboards", dashboardsRoute);
api.route("/api/companies", capTableRoute);
api.route("/api/companies", valuationCompaniesRoute);
api.route("/api/comp-panels", compPanelsRoute);
api.route("/api/documents", documentsRoute);
api.route("/api/data-rooms", dataRoomsRoute);
api.route("/api/persons", personsVerificationRoute);
// Task #18: Term-Sheet Intelligence — preferred-stack panel,
// per-investor term aggressiveness, and term benchmark distributions.
api.route("/api/companies", companiesPreferredStackRoute);
api.route("/api/investors", investorsTermAggressivenessRoute);
api.route("/api/term-benchmarks", termBenchmarksRoute);
api.route("/api/term-leaks", termLeaksRoute);
// Task #3: Edge-Quality Scoring + Power-Node Detection.
// Mounted at /api so the route owns /entities/:id/influence,
// /entities/:id/relationships, and /power-nodes. Must mount BEFORE
// any later catch-all but AFTER /api/entities/:id (the unified
// envelope route, which uses an exact-/:id match without trailing
// segments so it does not shadow these sub-paths).
api.route("/api", influenceRoute);
// Task #4: Intro Routing Engine — POST /api/intros/find,
// POST /api/intros/:path_id/log-outcome, GET /api/intros/model/current,
// GET /api/intros/by-target/:id.
api.route("/api/intros", introsRoute);
// Task #9: Predictions dashboard aggregator — single read endpoint
// that pulls top-N from intro_paths / fund_return_models /
// entity_influence in one round trip for the dashboard page.
api.route("/api/predictions", predictionsRoute);
// Task #6: Diligence Checklist Runner.
api.route("/api/diligence", diligenceRoute);
// Task #5: Investor Reputation + Founder CRM. Mounted at /api so the
// route owns /founder-feedback, /founder-pipelines/*, and
// /investors/:id/reputation in one module. Mounted AFTER
// investorsTermAggressivenessRoute so /:id/term-aggressiveness keeps
// its handler; Hono falls through to this mount when the prior
// sub-app returns no match.
api.route("/api", founderCrmRoute);
// Task #8: ML Quality Ops — eval runs, prompt registry, calibration,
// hallucination flags. Admin gating is inline via c.var.is_admin
// (populated by accessGuard) per the Task #14 inline-admin pattern.
api.route("/api/ml", mlRoute);
api.notFound((c) => c.json({ error: "not_found", request_id: c.var.request_id }, 404));
api.onError((err, c) => {
  const appErr = err instanceof AppError ? err : wrapUnknown(err, "internal_error");
  const requestIdVal = c.var.request_id;
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
  const isProd = c.env.ENVIRONMENT === "production" || !c.env.DEBUG;
  if (isProd) {
    const isUnknown = appErr.kind === "internal" || appErr.status >= 500;
    const safeMessage = isUnknown ? "Internal server error" : appErr.message;
    return c.json(
      { error: { code: appErr.code, message: safeMessage } },
      appErr.status as ContentfulStatusCode,
    );
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
    try {
    for (const msg of batch.messages) {
      const body = msg.body as QueueMessage | undefined;
      // Task #6 Section D: accept `import_file` as an alias for
      // `csv_import` — the legacy upload route was observed emitting
      // the alias; the queue handler must route both to the same
      // envelope so messages don't dead-letter.
      if (body && typeof body === "object" && ((body as { type?: string }).type === "csv_import" || (body as { type?: string }).type === "import_file") && typeof (body as { import_id?: unknown }).import_id === "string") {
        const stepStart = Date.now();
        const importId = (body as { import_id: string }).import_id;
        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();
        try {
          await env.DB.prepare(
            `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
             VALUES (?, ?, ?, 'queued', 'csv_import', ?, ?, ?, ?)`,
          ).bind(jobId, `csv_import:envelope:${importId}`, "csv_import", importId, JSON.stringify({ importId }), now, now).run();
          await runJob({ jobId, kind: "csv_import" as never, target: importId, config: { importId } }, env);
          msg.ack();
          batchAcked++;
          console.log("queue.step_end", JSON.stringify({ step: "csv_import_envelope", msg_id: msg.id, ms: Date.now() - stepStart, ok: true }));
        } catch (e) {
          const appErr = e instanceof AppError ? e : wrapUnknown(e, "queue_run_failed", { msgId: msg.id, op: "csv_import_envelope" });
          await logError(env, { err: appErr, step: "queue.csvImportEnvelope", retry_count: msg.attempts });
          console.log("queue.step_end", JSON.stringify({ step: "csv_import_envelope", msg_id: msg.id, ms: Date.now() - stepStart, ok: false, error_code: appErr.code }));
          if (msg.attempts < 3) { msg.retry({ delaySeconds: 30 * Math.pow(2, msg.attempts) }); batchRetried++; }
          else { msg.ack(); batchAcked++; batchFailed++; }
        }
        continue;
      }
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
        if (transient && attempts < 3) {
          console.warn("Queue retry (transient)", msg.id, appErr.code, appErr.message);
          if (jobId) {
            try {
              await env.DB.prepare(
                `UPDATE jobs SET retry_count = ?, last_error_code = ?, last_error_at = ? WHERE id = ?`,
              ).bind(attempts, appErr.code, now, jobId).run();
            } catch { }
          }
          msg.retry({ delaySeconds: Math.min(30 * Math.pow(2, attempts), 600) });
          batchRetried++;
          console.log("queue.step_end", JSON.stringify({ step: "runJob", msg_id: msg.id, job_id: jobId, ms: Date.now() - stepStart, ok: false, retry: true, error_code: appErr.code }));
        } else {
          const finalState = attempts >= 3 ? "dead_letter" : "failed";
          if (finalState === "dead_letter") batchDeadLettered++; else batchFailed++;
          console.error("Queue ack (permanent)", msg.id, finalState, appErr.code, appErr.message);
          if (jobId) {
            try {
              await env.DB.prepare(
                `UPDATE jobs SET status = ?, retry_count = ?, last_error_code = ?, last_error_at = ?, finished_at = COALESCE(finished_at, ?)
                  WHERE id = ? AND status IN ('queued','running')`,
              ).bind(finalState, attempts, appErr.code, now, now, jobId).run();
              await env.DB.prepare(
                `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by) VALUES (?, NULL, ?, ?, 'queue')`,
              ).bind(jobId, finalState, appErr.code).run();
            } catch { }
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