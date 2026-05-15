// Task #27: deep health endpoint.
//
// `/api/health` is the cheap liveness probe (200 + db ping).
// `/api/health/deep` is a per-binding readiness sweep that exercises every
// critical attached resource (D1, KV, R2, Queue, AI, Vectorize) and returns
// granular status. The dashboard's /dashboard/health/ page renders this.

import { Hono } from "hono";
import type { Env } from "../types";

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  let dbOk = false;
  try {
    const r = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    dbOk = r?.ok === 1;
  } catch (e) {
    console.error("Health DB check failed", (e as Error).message);
  }
  return c.json({
    status: dbOk ? "ok" : "degraded",
    service: "aidatasignal-worker",
    time: new Date().toISOString(),
    db: dbOk,
  });
});

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  required: boolean;
}

async function check(name: string, required: boolean, fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t0, detail: detail ?? undefined, required };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: (e as Error).message, required };
  }
}

health.get("/deep", async (c) => {
  const env = c.env;
  const checks: CheckResult[] = await Promise.all([
    check("d1.DB", true, async () => {
      const r = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (r?.ok !== 1) throw new Error("ping_failed");
      return "ok";
    }),
    check("d1.error_log", false, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_log").first<{ n: number }>();
      return `${r?.n ?? 0} rows`;
    }),
    check("d1.jobs_active", false, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").first<{ n: number }>();
      return `${r?.n ?? 0} active`;
    }),
    check("kv.SESSIONS", false, async () => {
      if (!env.SESSIONS) throw new Error("not_bound");
      await env.SESSIONS.get("__healthcheck__");
      return "ok";
    }),
    check("kv.SCRAPE_CACHE", false, async () => {
      if (!env.SCRAPE_CACHE) throw new Error("not_bound");
      await env.SCRAPE_CACHE.get("__healthcheck__");
      return "ok";
    }),
    check("r2.RAW_HTML", false, async () => {
      if (!env.RAW_HTML) throw new Error("not_bound");
      await env.RAW_HTML.head("__healthcheck__");
      return "ok";
    }),
    check("r2.UPLOADS", false, async () => {
      if (!env.UPLOADS) throw new Error("not_bound");
      await env.UPLOADS.head("__healthcheck__");
      return "ok";
    }),
    check("r2.AI_CACHE", false, async () => {
      if (!env.AI_CACHE) throw new Error("not_bound");
      await env.AI_CACHE.head("__healthcheck__");
      return "ok";
    }),
    check("ai.binding", false, async () => {
      if (!env.AI) throw new Error("not_bound");
      return "bound";
    }),
    check("vectorize.VEC_LEADS", false, async () => {
      if (!env.VEC_LEADS) throw new Error("not_bound");
      return "bound";
    }),
    check("queue.LEAD_QUEUE", false, async () => {
      if (!env.LEAD_QUEUE) throw new Error("not_bound");
      return "bound";
    }),
  ]);

  // Recent error counts
  let errors24h = 0;
  let errors1h = 0;
  try {
    const e24 = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE occurred_at >= ?`,
    ).bind(new Date(Date.now() - 24 * 3600 * 1000).toISOString()).first<{ n: number }>();
    const e1 = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE occurred_at >= ?`,
    ).bind(new Date(Date.now() - 3600 * 1000).toISOString()).first<{ n: number }>();
    errors24h = e24?.n ?? 0;
    errors1h = e1?.n ?? 0;
  } catch { /* ignore */ }

  const failingRequired = checks.filter((c0) => c0.required && !c0.ok);
  const failingOptional = checks.filter((c0) => !c0.required && !c0.ok);
  const status = failingRequired.length ? "fail" : failingOptional.length ? "degraded" : "ok";

  return c.json({
    status,
    service: "aidatasignal-worker",
    time: new Date().toISOString(),
    checks,
    errors: { last_1h: errors1h, last_24h: errors24h },
  });
});
