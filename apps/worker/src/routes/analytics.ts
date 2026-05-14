import { Hono } from "hono";
import type { Env } from "../types";
import { AnalyticsService } from "../services/analytics.service";

export const analytics = new Hono<{ Bindings: Env; Variables: { email: string } }>();

analytics.get("/summary", async (c) => {
  const svc = new AnalyticsService(c.env.DB);
  const summary = await svc.getSummary();
  return c.json(summary);
});

analytics.get("/trends", async (c) => {
  const days = Number(c.req.query("days") ?? "14");
  const svc = new AnalyticsService(c.env.DB);
  const trends = await svc.getTrends(days);
  return c.json({ days, points: trends });
});

analytics.get("/sources", async (c) => {
  const svc = new AnalyticsService(c.env.DB);
  const sources = await svc.getTopSources();
  return c.json({ items: sources });
});

analytics.post("/event", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; props?: unknown; path?: string };
  if (!body.name) return c.json({ error: "missing_name" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO analytics_events (id, name, path, props_json, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), body.name, body.path ?? "", JSON.stringify(body.props ?? {}), new Date().toISOString())
    .run();
  return c.json({ ok: true });
});
