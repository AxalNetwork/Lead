// Task #3: IntlAdapter registry + dispatch.
//
// One source-of-truth list. Engine routes by either:
//   (1) explicit `jurisdiction` hint on the seed row (preferred), or
//   (2) host / TLD fallback (heuristic).
//
// Per-host throttle is read off the adapter's `throttle` field — see
// crawler/hostThrottle.ts integration via getThrottleFor(host).

import type { IntlAdapter, JurisdictionCode } from "./types";
import { safeHost } from "../_util";

import { ukIntl } from "./uk";
import { euEsmaIntl } from "./eu_esma";
import { deIntl } from "./de";
import { frIntl } from "./fr";
import { nlIntl } from "./nl";
import { seIntl } from "./se";
import { esIntl } from "./es";
import { itIntl } from "./it";
import { ieIntl } from "./ie";
import { sgIntl } from "./sg";
import { ilIntl } from "./il";
import { inIntl } from "./in";
import { cnIntl } from "./cn";
import { hkIntl } from "./hk";
import { caIntl } from "./ca";
import { auIntl } from "./au";
import { brIntl } from "./br";

export const INTL_ADAPTERS: IntlAdapter[] = [
  ukIntl, euEsmaIntl, deIntl, frIntl, nlIntl, seIntl, esIntl, itIntl,
  ieIntl, sgIntl, ilIntl, inIntl, cnIntl, hkIntl, caIntl, auIntl, brIntl,
];

const BY_JURISDICTION = new Map<JurisdictionCode, IntlAdapter>(
  INTL_ADAPTERS.map((a) => [a.jurisdiction, a]),
);

const BY_HOST = new Map<string, IntlAdapter>();
for (const a of INTL_ADAPTERS) for (const h of a.hosts) BY_HOST.set(h.toLowerCase(), a);

/** TLD → jurisdiction fallback used when the seed row has no explicit
 *  hint and no host match. Conservative: only pick when the TLD is
 *  unambiguously a country-code TLD bound to one of our adapters. */
const TLD_TO_JURISDICTION: Record<string, JurisdictionCode> = {
  uk: "UK", de: "DE", fr: "FR", nl: "NL", se: "SE", es: "ES", it: "IT",
  ie: "IE", sg: "SG", il: "IL", in: "IN", cn: "CN", hk: "HK", ca: "CA",
  au: "AU", br: "BR",
};

export function getIntlAdapter(jurisdiction: JurisdictionCode): IntlAdapter | null {
  return BY_JURISDICTION.get(jurisdiction) ?? null;
}

/** Engine dispatch: returns the adapter that should handle this URL,
 *  preferring the explicit hint, falling back to host match, then to
 *  TLD heuristic. Returns null when none match — the engine then falls
 *  through to the generic adapter pipeline. */
export function pickIntlAdapter(url: string, jurisdictionHint?: JurisdictionCode | null): IntlAdapter | null {
  if (jurisdictionHint) {
    const a = BY_JURISDICTION.get(jurisdictionHint);
    if (a) return a;
  }
  const host = safeHost(url);
  if (!host) return null;
  // Exact host first.
  const exact = BY_HOST.get(host);
  if (exact) return exact;
  // Suffix match (subdomains).
  for (const [h, a] of BY_HOST) {
    if (host === h || host.endsWith(`.${h}`)) return a;
  }
  // TLD fallback: pick the country-code TLD if known.
  const tld = host.split(".").pop()?.toLowerCase() ?? "";
  const j = TLD_TO_JURISDICTION[tld];
  if (j) {
    const a = BY_JURISDICTION.get(j);
    if (a) return a;
  }
  return null;
}

/** Per-host throttle resolver. The HostThrottle DO consults this to
 *  apply per-source rps/burst caps. Returns null when the host isn't
 *  bound to any intl adapter (the DO then uses its global default). */
export function getThrottleFor(host: string): { rps: number; burst: number } | null {
  const h = host.toLowerCase();
  const exact = BY_HOST.get(h);
  if (exact) return exact.throttle;
  for (const [bh, a] of BY_HOST) {
    if (h === bh || h.endsWith(`.${bh}`)) return a.throttle;
  }
  return null;
}

export type { IntlAdapter, IntlEntityHit, IntlFiling, JurisdictionCode } from "./types";
