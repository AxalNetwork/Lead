import { Hono } from "hono";
import type { Env } from "../types";
import { AnalyticsV2Service } from "../services/analytics_v2.service";
import { computeQuality } from "../scoring/quality";

export const analyticsV2 = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function clampDays(raw: string | undefined, def: number, max = 90): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, Math.floor(n));
}

analyticsV2.get("/scrapers/health", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.scrapersHealth());
});

analyticsV2.get("/scrapers/cost", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.scrapersCost(clampDays(c.req.query("days"), 30)));
});

analyticsV2.get("/leads/quality", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.leadsQuality(clampDays(c.req.query("days"), 30)));
});

analyticsV2.get("/leads/quality/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare(
      `SELECT id, name, email, org, title, phone, linkedin_url, country_iso2, city,
              persona_role, seniority, bio, verified, last_enriched_at,
              enrichment_log_json, companies_json, board_seats_json, awards_json, exits_json
         FROM leads WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(computeQuality(row));
});

analyticsV2.get("/leads/funnel", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.leadsFunnel());
});

analyticsV2.get("/leads/segments", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.leadsSegments());
});

analyticsV2.get("/leads/value", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.leadsValue());
});

analyticsV2.get("/jobs/perf", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json(await svc.jobsPerf(clampDays(c.req.query("days"), 30)));
});

analyticsV2.get("/trends/leads", async (c) => {
  const svc = new AnalyticsV2Service(c.env);
  return c.json({ points: await svc.trendLeads(clampDays(c.req.query("days"), 30)) });
});
