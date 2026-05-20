// Task #5: External API probe registry.
//
// One entry per external integration the worker uses. The "cheap"
// endpoint is one that costs us a rate-limit unit but no real work
// (e.g. a status page, an empty search, the OAuth metadata endpoint).
// When the required env var is absent we record an `unconfigured`
// row rather than silently skipping — same honest-degradation pattern
// as Task #14 verification / Task #18 term sheets.

import type { Env } from "../../types";

export interface ProbeResult {
  api_name: string;
  ok: boolean;
  latency_ms: number;
  status_code: number | null;
  rate_limit_remaining: number | null;
  error: string | null;
  configured: boolean;
}

export interface ProbeDef {
  name: string;
  /** Returns true when the required env var(s) are present. */
  configured: (env: Env) => boolean;
  /** Cheap GET URL or a function returning it. */
  url: string | ((env: Env) => string);
  /** Optional extra request init (UA, auth headers). */
  init?: (env: Env) => RequestInit;
  /** Parse a rate-limit header from the response (optional). */
  parseRateLimit?: (res: Response) => number | null;
}

const SEC_EDGAR_UA_FALLBACK = "AIDataSignal/1.0 (admin@aidatasignal.com)";

export const PROBE_REGISTRY: ReadonlyArray<ProbeDef> = [
  {
    name: "sec_edgar",
    configured: () => true,
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&dateb=&owner=include&count=1&action=getcompany",
    init: (env) => ({ headers: { "User-Agent": env.SEC_EDGAR_UA ?? SEC_EDGAR_UA_FALLBACK } }),
  },
  {
    name: "courtlistener",
    configured: (env) => !!env.COURTLISTENER_TOKEN,
    url: "https://www.courtlistener.com/api/rest/v3/courts/?page_size=1",
    init: (env) => ({ headers: { Authorization: `Token ${env.COURTLISTENER_TOKEN}` } }),
    parseRateLimit: (res) => {
      const v = res.headers.get("x-ratelimit-remaining");
      return v == null ? null : Number(v);
    },
  },
  {
    name: "fec",
    configured: (env) => !!env.FEC_API_KEY,
    url: (env) => `https://api.open.fec.gov/v1/elections/?per_page=1&api_key=${env.FEC_API_KEY}`,
    parseRateLimit: (res) => {
      const v = res.headers.get("x-ratelimit-remaining");
      return v == null ? null : Number(v);
    },
  },
  {
    name: "opensecrets",
    configured: (env) => !!env.OPENSECRETS_API_KEY,
    url: (env) => `https://www.opensecrets.org/api/?method=getLegislators&id=NJ&output=json&apikey=${env.OPENSECRETS_API_KEY}`,
  },
  {
    name: "companies_house",
    configured: (env) => !!env.COMPANIES_HOUSE_API_KEY,
    url: "https://api.company-information.service.gov.uk/search/companies?q=test&items_per_page=1",
    init: (env) => ({ headers: { Authorization: `Basic ${btoa((env.COMPANIES_HOUSE_API_KEY ?? "") + ":")}` } }),
  },
  {
    name: "newsapi",
    configured: (env) => !!env.NEWS_API_KEY,
    url: (env) => `https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey=${env.NEWS_API_KEY}`,
  },
  {
    name: "congress",
    configured: (env) => !!env.CONGRESS_API_KEY,
    url: (env) => `https://api.congress.gov/v3/congress?limit=1&api_key=${env.CONGRESS_API_KEY}`,
  },
  {
    name: "propublica_congress",
    configured: (env) => !!env.PROPUBLICA_API_KEY,
    url: "https://api.propublica.org/congress/v1/118/senate/members.json",
    init: (env) => ({ headers: { "X-API-Key": env.PROPUBLICA_API_KEY ?? "" } }),
  },
  {
    name: "clinicaltrials",
    configured: () => true,
    url: "https://clinicaltrials.gov/api/v2/studies?pageSize=1",
  },
  {
    name: "mailchannels",
    configured: () => true,
    // MailChannels public docs URL — cheap health probe.
    url: "https://api.mailchannels.net/tx/v1/documentation",
  },
];

/** Probe a single API; never throws. */
export async function runProbe(env: Env, def: ProbeDef): Promise<ProbeResult> {
  const t0 = Date.now();
  if (!def.configured(env)) {
    return {
      api_name: def.name,
      ok: false,
      latency_ms: 0,
      status_code: null,
      rate_limit_remaining: null,
      error: "unconfigured",
      configured: false,
    };
  }
  const url = typeof def.url === "function" ? def.url(env) : def.url;
  const init = def.init ? def.init(env) : {};
  try {
    const res = await fetch(url, {
      method: "GET",
      ...init,
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t0;
    const rl = def.parseRateLimit ? def.parseRateLimit(res) : null;
    return {
      api_name: def.name,
      ok: res.ok,
      latency_ms: latency,
      status_code: res.status,
      rate_limit_remaining: rl,
      error: res.ok ? null : `http_${res.status}`,
      configured: true,
    };
  } catch (e) {
    return {
      api_name: def.name,
      ok: false,
      latency_ms: Date.now() - t0,
      status_code: null,
      rate_limit_remaining: null,
      error: `network:${(e as Error).message}`.slice(0, 200),
      configured: true,
    };
  }
}

export async function writeProbe(env: Env, r: ProbeResult): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO external_api_probes
         (api_name, probed_at, ok, latency_ms, status_code, rate_limit_remaining, error, configured)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
    ).bind(
      r.api_name,
      r.ok ? 1 : 0,
      r.latency_ms,
      r.status_code,
      r.rate_limit_remaining,
      r.error,
      r.configured ? 1 : 0,
    ).run();
  } catch (e) {
    console.warn("external_api_probes insert failed", (e as Error).message);
  }
}

export async function runAllProbes(env: Env): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const def of PROBE_REGISTRY) {
    const r = await runProbe(env, def);
    await writeProbe(env, r);
    results.push(r);
  }
  return results;
}

export function findProbe(name: string): ProbeDef | null {
  return PROBE_REGISTRY.find((p) => p.name === name) ?? null;
}

export const PROBE_NAMES: ReadonlyArray<string> = PROBE_REGISTRY.map((p) => p.name);
