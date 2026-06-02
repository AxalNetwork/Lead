// Task #27: deep health endpoint.
//
// `/health` is the cheap public liveness probe (200 + db ping).
// `/api/health/deep` is per-binding readiness sweep that exercises every
// critical attached resource (D1, KV, R2, Queue, AI, Vectorize, Browser)
// AND probes every enrichment provider for credential presence. Response
// shape follows the spec contract:
//   { binding: string, status: "ok"|"degraded"|"fail", latency_ms: number, error?: string }
// per check.

import { Hono } from "hono";
import type { Env } from "../types";

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  let dbOk = false;
  try {
    const r = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    dbOk = r?.ok === 1;
  } catch (e) {
    // Surface failure in response payload instead of console (CI gate).
  }
  return c.json({
    status: dbOk ? "ok" : "degraded",
    service: "aidatasignal-worker",
    time: new Date().toISOString(),
    db: dbOk,
  });
});

interface CheckResult {
  binding: string;
  status: "ok" | "degraded" | "fail";
  latency_ms: number;
  error?: string;
  required: boolean;
  detail?: string;
}

async function probe(
  binding: string,
  required: boolean,
  fn: () => Promise<{ status?: "ok" | "degraded"; detail?: string } | string | void>,
): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const latency_ms = Date.now() - t0;
    if (typeof r === "string") return { binding, status: "ok", latency_ms, required, detail: r };
    if (r && typeof r === "object") {
      const out: CheckResult = { binding, status: r.status ?? "ok", latency_ms, required };
      if (r.detail) out.detail = r.detail;
      return out;
    }
    return { binding, status: "ok", latency_ms, required };
  } catch (e) {
    return { binding, status: required ? "fail" : "degraded", latency_ms: Date.now() - t0, required, error: (e as Error).message };
  }
}

// Task #5: the per-paid-provider probes (apollo/hunter/rocketreach/pdl/
// proxycurl/crunchbase/opencorporates/uk_ch/whoisxml/builtwith/brave/
// forbes_signals/scraper_api) were removed when the third-party APIs
// were ripped out. The in-house crawler stack is now represented by two
// consolidated probes: `crawler:fetcher` (does a cheap fetchPage of a
// known-good public URL) and `crawler:archive` (R2 head smoke).
import { fetchPage } from "../scraper/fetcher";

async function probeCrawlerFetcher(env: Env): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    // The probe walks every fetcher tier (escalation is triggered by the
    // content-quality reasons below), and the proxy tier in particular can
    // take a few seconds, so give each attempt a generous budget — a
    // slightly-slow-but-healthy fetch must not be reported as a timeout.
    const r = await fetchPage(env, "https://example.com/", {
      liveOnly: true, skipPolicy: true, timeoutMs: 8000, minIntervalMs: 0,
    });
    const reason = r.blockReason ?? "";
    // An optional tier being intentionally unconfigured (no PROXY_URL,
    // no BROWSER binding) is a CONFIG STATE, not a fetcher fault — the
    // probe should not flip the binding to "degraded" on it. We surface
    // the same situation as "ok" with an informational detail so
    // operators can still see which optional tier is unset.
    const unconfiguredTier =
      reason === "proxy_not_configured" ||
      reason === "browser_binding_unavailable" ||
      reason === "puppeteer_module_missing";
    // `too_small` / `low_visible_text` are CONTENT-QUALITY judgements meant
    // for real scrape OUTPUT, not a fetcher-liveness signal. The probe URL
    // (example.com) is a genuinely tiny (~1.2 KB) real page, so applying the
    // scrape heuristic here made the probe flag itself as `degraded` even
    // though the fetch succeeded. For a liveness check, a real 2xx response
    // with a non-empty body is healthy regardless of how small that body is.
    const fetchSucceeded = r.status >= 200 && r.status < 300 && r.html.length > 0;
    const contentQualityOnly =
      (reason === "too_small" || reason === "low_visible_text") && fetchSucceeded;
    // A genuine fetcher fault (timeout, captcha, status_4xx/5xx, thrown
    // error, proxy/browser error) still reports "degraded".
    const ok = (r.ok && r.html.length > 0) || contentQualityOnly;
    return {
      binding: "crawler:fetcher",
      status: ok || unconfiguredTier ? "ok" : "degraded",
      latency_ms: Date.now() - t0,
      required: false,
      detail: ok
        ? `tier_${r.tier} http_${r.status}${contentQualityOnly ? ` ${reason}` : ""}`
        : unconfiguredTier
        ? `optional_tier_unconfigured:${reason}`
        : (r.blockReason ?? `tier_${r.tier}`),
    };
  } catch (e) {
    return {
      binding: "crawler:fetcher",
      status: "degraded",
      latency_ms: Date.now() - t0,
      required: false,
      error: (e as Error).message || "fetch_failed",
    };
  }
}

async function probeCrawlerArchive(env: Env): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    if (!env.RAW_HTML) throw new Error("not_bound");
    await env.RAW_HTML.head("__crawler_archive_healthcheck__");
    return { binding: "crawler:archive", status: "ok", latency_ms: Date.now() - t0, required: false, detail: "r2_head_ok" };
  } catch (e) {
    return {
      binding: "crawler:archive",
      status: "degraded",
      latency_ms: Date.now() - t0,
      required: false,
      error: (e as Error).message || "head_failed",
    };
  }
}

health.get("/deep", async (c) => {
  const env = c.env;
  const checks: CheckResult[] = await Promise.all([
    probe("d1.DB", true, async () => {
      const r = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (r?.ok !== 1) throw new Error("ping_failed");
      return "ok";
    }),
    probe("d1.error_log", false, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_log").first<{ n: number }>();
      return `${r?.n ?? 0} rows`;
    }),
    probe("d1.jobs_active", false, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").first<{ n: number }>();
      return `${r?.n ?? 0} active`;
    }),
    probe("kv.SESSIONS", false, async () => {
      if (!env.SESSIONS) throw new Error("not_bound");
      await env.SESSIONS.get("__healthcheck__");
      return "ok";
    }),
    probe("kv.SCRAPE_CACHE", false, async () => {
      if (!env.SCRAPE_CACHE) throw new Error("not_bound");
      await env.SCRAPE_CACHE.get("__healthcheck__");
      return "ok";
    }),
    probe("r2.RAW_HTML", false, async () => {
      if (!env.RAW_HTML) throw new Error("not_bound");
      await env.RAW_HTML.head("__healthcheck__");
      return "ok";
    }),
    probe("r2.UPLOADS", false, async () => {
      if (!env.UPLOADS) throw new Error("not_bound");
      await env.UPLOADS.head("__healthcheck__");
      return "ok";
    }),
    probe("r2.AI_CACHE", false, async () => {
      if (!env.AI_CACHE) throw new Error("not_bound");
      await env.AI_CACHE.head("__healthcheck__");
      return "ok";
    }),
    probe("ai.binding", false, async () => (env.AI ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("vectorize.VEC_LEADS", false, async () => (env.VEC_LEADS ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("vectorize.VEC_FIRMS", false, async () => (env.VEC_FIRMS ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("vectorize.VEC_COMPANIES", false, async () => (env.VEC_COMPANIES ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("queue.LEAD_QUEUE", false, async () => (env.LEAD_QUEUE ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("browser.BROWSER", false, async () => (env.BROWSER ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("analytics.ANALYTICS", false, async () => (env.ANALYTICS ? "bound" : (() => { throw new Error("not_bound"); })())),
    probe("do.ENTITY_LOCK", false, async () => (env.ENTITY_LOCK ? "bound" : (() => { throw new Error("not_bound"); })())),
    probeCrawlerFetcher(env),
    probeCrawlerArchive(env),
  ]);

  // Recent error counts.
  let errors24h = 0, errors1h = 0;
  try {
    const e24 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM error_log WHERE occurred_at >= ?`)
      .bind(new Date(Date.now() - 24 * 3600 * 1000).toISOString()).first<{ n: number }>();
    const e1 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM error_log WHERE occurred_at >= ?`)
      .bind(new Date(Date.now() - 3600 * 1000).toISOString()).first<{ n: number }>();
    errors24h = e24?.n ?? 0;
    errors1h = e1?.n ?? 0;
  } catch { /* ignore */ }

  const failingRequired = checks.filter((c0) => c0.required && c0.status === "fail");
  const degraded = checks.filter((c0) => c0.status !== "ok");
  const status: "ok" | "degraded" | "fail" = failingRequired.length ? "fail" : degraded.length ? "degraded" : "ok";

  return c.json({
    status,
    service: "aidatasignal-worker",
    time: new Date().toISOString(),
    checks,
    errors: { last_1h: errors1h, last_24h: errors24h },
  });
});
