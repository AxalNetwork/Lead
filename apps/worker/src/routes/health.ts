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

// Per-provider live credential validity probe. Each probe issues ONE cheap
// authenticated request with a strict 4-second AbortSignal timeout. We
// classify HTTP responses as:
//   2xx           -> ok           (key is valid, provider reachable)
//   401/403       -> fail         (key is rejected — invalid / revoked)
//   404           -> ok           (route not found but auth was accepted)
//   429           -> degraded     (rate-limited, but key is valid)
//   408/5xx       -> degraded     (provider transient outage)
//   other         -> degraded
// This satisfies the spec criterion that flipping a secret to an invalid
// value must surface as `fail` on /api/health/deep.
interface ProviderProbe {
  name: string;
  envKey: keyof Env;
  build: (key: string) => { url: string; init?: RequestInit };
}

function classifyHttp(status: number): { status: "ok" | "degraded" | "fail"; detail: string } {
  if (status >= 200 && status < 300) return { status: "ok", detail: `http_${status}` };
  if (status === 404) return { status: "ok", detail: "http_404 (auth ok)" };
  if (status === 401 || status === 403) return { status: "fail", detail: `http_${status} (auth rejected)` };
  if (status === 429) return { status: "degraded", detail: "http_429 (rate limited)" };
  if (status === 408 || status >= 500) return { status: "degraded", detail: `http_${status}` };
  return { status: "degraded", detail: `http_${status}` };
}

const PROVIDER_PROBES: ProviderProbe[] = [
  { name: "provider:apollo", envKey: "APOLLO_API_KEY", build: (k) => ({
      url: "https://api.apollo.io/v1/auth/health", init: { method: "GET", headers: { "X-Api-Key": k } } }) },
  { name: "provider:hunter", envKey: "HUNTER_API_KEY", build: (k) => ({
      url: `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(k)}`, init: { method: "GET" } }) },
  { name: "provider:rocketreach", envKey: "ROCKETREACH_API_KEY", build: (k) => ({
      url: "https://api.rocketreach.co/v2/api/account/", init: { method: "GET", headers: { "Api-Key": k } } }) },
  { name: "provider:peopledatalabs", envKey: "PEOPLEDATALABS_API_KEY", build: (k) => ({
      url: "https://api.peopledatalabs.com/v5/account", init: { method: "GET", headers: { "X-Api-Key": k } } }) },
  { name: "provider:proxycurl", envKey: "PROXYCURL_API_KEY", build: (k) => ({
      url: "https://nubela.co/proxycurl/api/credit-balance", init: { method: "GET", headers: { Authorization: `Bearer ${k}` } } }) },
  { name: "provider:crunchbase", envKey: "CRUNCHBASE_API_KEY", build: (k) => ({
      url: `https://api.crunchbase.com/api/v4/entities/organizations/crunchbase?card_ids=fields&user_key=${encodeURIComponent(k)}`, init: { method: "GET" } }) },
  { name: "provider:opencorporates", envKey: "OPENCORPORATES_API_KEY", build: (k) => ({
      url: `https://api.opencorporates.com/v0.4/account_status?api_token=${encodeURIComponent(k)}`, init: { method: "GET" } }) },
  { name: "provider:uk_ch", envKey: "UK_CH_API_KEY", build: (k) => ({
      url: "https://api.company-information.service.gov.uk/company/00000006",
      init: { method: "GET", headers: { Authorization: "Basic " + btoa(`${k}:`) } } }) },
  { name: "provider:whoisxml", envKey: "WHOISXML_API_KEY", build: (k) => ({
      url: `https://www.whoisxmlapi.com/whoisserver/WhoisService?domainName=example.com&apiKey=${encodeURIComponent(k)}&outputFormat=json`, init: { method: "GET" } }) },
  { name: "provider:builtwith", envKey: "BUILTWITH_API_KEY", build: (k) => ({
      url: `https://api.builtwith.com/free1/api.json?KEY=${encodeURIComponent(k)}&LOOKUP=example.com`, init: { method: "GET" } }) },
  { name: "provider:brave", envKey: "BRAVE_API_KEY", build: (k) => ({
      url: "https://api.search.brave.com/res/v1/web/search?q=health&count=1",
      init: { method: "GET", headers: { "X-Subscription-Token": k, Accept: "application/json" } } }) },
  // Forbes signals + scraper_api don't have a public auth-check endpoint we
  // can probe cheaply; fall back to key presence only.
];

const PROVIDER_KEY_ONLY: Array<{ name: string; envKey: keyof Env }> = [
  { name: "provider:forbes_signals", envKey: "FORBES_SIGNALS_KEY" },
  { name: "provider:scraper_api",    envKey: "SCRAPER_API_KEY" },
];

async function probeProvider(env: Env, p: ProviderProbe): Promise<CheckResult> {
  const t0 = Date.now();
  const v = env[p.envKey];
  if (!v || (typeof v === "string" && !v.trim())) {
    return { binding: p.name, status: "degraded", latency_ms: 0, required: false, detail: "missing_key" };
  }
  const { url, init } = p.build(v as string);
  try {
    const r = await fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(4000) });
    const cls = classifyHttp(r.status);
    return { binding: p.name, status: cls.status, latency_ms: Date.now() - t0, required: false, detail: cls.detail };
  } catch (e) {
    const msg = (e as Error).message || "fetch_failed";
    const isTimeout = msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("aborted");
    return { binding: p.name, status: "degraded", latency_ms: Date.now() - t0, required: false, error: isTimeout ? "timeout" : msg };
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
    ...PROVIDER_PROBES.map((p) => probeProvider(env, p)),
    ...PROVIDER_KEY_ONLY.map((p) => probe(p.name, false, async () => {
      const v = env[p.envKey];
      if (!v || (typeof v === "string" && !v.trim())) throw new Error("missing_key");
      return { status: "ok" as const, detail: "key_present (no probe endpoint)" };
    })),
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
