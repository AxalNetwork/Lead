import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, JobMessage } from "./types";
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
export { EntityLock } from "./do/EntityLock";
export { EnrichLeadWorkflow, EnrichFirmWorkflow, IngestPageWorkflow, EnrichAccountWorkflow, CrawlSignalsWorkflow } from "./ai/workflows";
import { piiAuditOnLeadGet } from "./middleware/pii_audit";
import { accessGuard } from "./middleware/access";
import { runJob } from "./scraper/pipeline";
import { scheduled as scheduledHandler } from "./scheduled";

const API_HOST = "api.aidatasignal.com";

const api = new Hono<{ Bindings: Env; Variables: { email: string } }>();

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

api.route("/health", health);
// Public webhook (HMAC-signed) — must be mounted *before* accessGuard so
// marketing tools can post events without a Cloudflare Access cookie.
api.route("/api/campaigns", campaignsWebhook);
api.use("/api/*", accessGuard);
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
// /api/leads/:id/enrich, /api/leads/enrich/bulk, /:id/dnc, /:id/campaigns
api.route("/api/leads", leadsEnrichActions);
api.route("/api/leads", leadsDncActions);
api.route("/api/leads", leadsCampaignActions);

api.notFound((c) => c.json({ error: "not_found" }, 404));
api.onError((err, c) => {
  console.error("Worker error", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (host === API_HOST) return api.fetch(req, env, ctx);
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        if (!body || typeof body !== "object" || !("jobId" in body) || !("kind" in body) || !("target" in body)) {
          console.warn("Skipping malformed queue message", msg.id);
          msg.ack();
          continue;
        }
        await runJob(body as JobMessage, env);
        msg.ack();
      } catch (e) {
        const message = (e as Error).message ?? "";
        // Permanent failures already wrote status='failed' on the job row;
        // only retry on transient signals so we don't loop on dead URLs.
        const transient =
          message.includes("status_429") ||
          message.includes("status_503") ||
          message.includes("status_502") ||
          message.includes("status_504") ||
          message.includes("fetch_error") ||
          message.includes("D1_ERROR") ||
          message.includes("Network connection lost");
        if (transient) {
          console.warn("Queue retry (transient)", msg.id, message);
          msg.retry({ delaySeconds: 30 });
        } else {
          console.error("Queue ack (permanent)", msg.id, message);
          msg.ack();
        }
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledHandler(event, env, ctx);
  },
};
