import type { Env } from "../types";

// Task #16: failover pool of commercial proxy providers. The crawler's
// tier-2 proxy step tries each configured provider in a fixed order and
// only reports failure once every provider has failed. This module is the
// single source of truth for "is any proxy configured" and "which
// providers, in what order, do we try".
//
// All providers speak the same HTTP-forward + basic-auth shape that
// Smartproxy / Bright Data / Oxylabs "Web Unblocker" style endpoints use:
// the target URL is appended as a `url=` query param and the credentials
// are sent as HTTP Basic auth. The legacy generic pair (PROXY_URL /
// PROXY_AUTH) is kept first so existing single-provider deployments keep
// their current behavior unchanged.

export interface ProxyProvider {
  /** Stable identifier surfaced in attempt logs (e.g. "smartproxy"). */
  name: string;
  /** HTTP-forward base URL the target URL is appended to. */
  url: string;
  /** Optional `user:pass` sent as HTTP Basic auth to the provider. */
  auth?: string;
}

const PROVIDER_SLOTS: ReadonlyArray<{
  name: string;
  url: (env: Env) => string | undefined;
  auth: (env: Env) => string | undefined;
}> = [
  { name: "generic", url: (e) => e.PROXY_URL, auth: (e) => e.PROXY_AUTH },
  { name: "smartproxy", url: (e) => e.SMARTPROXY_URL, auth: (e) => e.SMARTPROXY_AUTH },
  { name: "brightdata", url: (e) => e.BRIGHTDATA_URL, auth: (e) => e.BRIGHTDATA_AUTH },
  { name: "oxylabs", url: (e) => e.OXYLABS_URL, auth: (e) => e.OXYLABS_AUTH },
];

/**
 * Ordered list of configured proxy providers. A provider is "configured"
 * when its forward URL secret is set; auth is optional. Providers with no
 * URL are skipped. Order is fixed: generic (legacy) → Smartproxy → Bright
 * Data → Oxylabs.
 */
export function getProxyProviders(env: Env): ProxyProvider[] {
  const out: ProxyProvider[] = [];
  for (const slot of PROVIDER_SLOTS) {
    const url = slot.url(env);
    if (!url) continue;
    const auth = slot.auth(env);
    out.push(auth ? { name: slot.name, url, auth } : { name: slot.name, url });
  }
  return out;
}

/** True when at least one proxy provider is configured. */
export function hasAnyProxy(env: Env): boolean {
  return getProxyProviders(env).length > 0;
}
