import type { Env } from "../types";

// Task #16 / Task #39: failover pool of commercial proxy providers. The
// crawler's tier-2 proxy step tries each configured provider in a fixed
// order and only reports failure once every provider has failed. This
// module is the single source of truth for "is any proxy configured" and
// "which providers, in what order, do we try".
//
// Two provider shapes are supported:
//
//   - mode "forward" (Smartproxy / Bright Data / Oxylabs "Web Unblocker"
//     style): the target URL is appended as a `url=` query param and the
//     credentials are sent as HTTP Basic auth. The legacy generic pair
//     (PROXY_URL / PROXY_AUTH) uses this shape and is kept first so
//     existing single-provider deployments are unchanged.
//
//   - mode "api" (ScraperAPI / scrapestack, added in Task #39): the API
//     key rides in the request as a query param on the provider's API
//     base URL (e.g. `api.scraperapi.com/?api_key=KEY&url=TARGET`). The
//     target URL is still appended as a `url=` param by the fetcher, and
//     NO Authorization header is sent — the key is already in the URL.
//
// Decodo is Smartproxy's rebrand, so the `SMARTPROXY_*` slot covers it.

export type ProxyMode = "forward" | "api";

export interface ProxyProvider {
  /** Stable identifier surfaced in attempt logs (e.g. "smartproxy"). */
  name: string;
  /**
   * Base URL the target URL is appended to as `url=`. For forward
   * providers this is the HTTP-forward endpoint; for API providers it
   * already carries the API key as a query param.
   */
  url: string;
  /** Optional `user:pass` sent as HTTP Basic auth (forward mode only). */
  auth?: string;
  /** Transport shape. Defaults to "forward" when omitted. */
  mode?: ProxyMode;
}

/** A slot resolves to a configured provider, or undefined when its
 *  required secret(s) are absent (the slot is then skipped). */
type ProviderSlot = (env: Env) => ProxyProvider | undefined;

/** Forward-proxy slot: active when `url` secret is set; auth optional. */
function forwardSlot(
  name: string,
  url: (env: Env) => string | undefined,
  auth: (env: Env) => string | undefined,
): ProviderSlot {
  return (env) => {
    const u = url(env);
    if (!u) return undefined;
    const a = auth(env);
    // mode is omitted (defaults to "forward") so the legacy provider
    // object shape is preserved for existing single-provider deployments.
    return a ? { name, url: u, auth: a } : { name, url: u };
  };
}

/** API-mode slot: active when the API key secret is set. The key (and
 *  any optional params) are baked into the base URL; no auth header. */
function apiSlot(
  name: string,
  key: (env: Env) => string | undefined,
  buildUrl: (key: string, env: Env) => string,
): ProviderSlot {
  return (env) => {
    const k = key(env);
    if (!k) return undefined;
    return { name, url: buildUrl(k, env), mode: "api" };
  };
}

const PROVIDER_SLOTS: ReadonlyArray<ProviderSlot> = [
  // Forward proxies, tried first in fixed order.
  forwardSlot("generic", (e) => e.PROXY_URL, (e) => e.PROXY_AUTH),
  forwardSlot("smartproxy", (e) => e.SMARTPROXY_URL, (e) => e.SMARTPROXY_AUTH),
  forwardSlot("brightdata", (e) => e.BRIGHTDATA_URL, (e) => e.BRIGHTDATA_AUTH),
  forwardSlot("oxylabs", (e) => e.OXYLABS_URL, (e) => e.OXYLABS_AUTH),
  // API-mode providers (Task #39), tried after the forward proxies.
  apiSlot(
    "scraperapi",
    (e) => e.SCRAPERAPI_KEY,
    (key, e) =>
      `https://api.scraperapi.com/?api_key=${encodeURIComponent(key)}` +
      (e.SCRAPERAPI_COUNTRY
        ? `&country_code=${encodeURIComponent(e.SCRAPERAPI_COUNTRY)}`
        : ""),
  ),
  apiSlot(
    "scrapestack",
    (e) => e.SCRAPESTACK_KEY,
    (key, e) =>
      `https://api.scrapestack.com/scrape?access_key=${encodeURIComponent(key)}` +
      (e.SCRAPESTACK_COUNTRY
        ? `&proxy_location=${encodeURIComponent(e.SCRAPESTACK_COUNTRY)}`
        : ""),
  ),
];

/**
 * Ordered list of configured proxy providers. A forward provider is
 * "configured" when its forward URL secret is set (auth optional); an
 * API provider when its API key secret is set. Unconfigured slots are
 * skipped. Order is fixed: generic (legacy) → Smartproxy → Bright Data →
 * Oxylabs → ScraperAPI → scrapestack.
 */
export function getProxyProviders(env: Env): ProxyProvider[] {
  const out: ProxyProvider[] = [];
  for (const slot of PROVIDER_SLOTS) {
    const provider = slot(env);
    if (provider) out.push(provider);
  }
  return out;
}

/** True when at least one proxy provider is configured. */
export function hasAnyProxy(env: Env): boolean {
  return getProxyProviders(env).length > 0;
}
