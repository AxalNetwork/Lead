// Task #2: SiteAdapter registry. Selection is deterministic — every
// adapter declares the hosts and url_patterns it claims; pickAdapter()
// returns the highest-priority match. The crawler engine consults the
// registry first, falls back to the generic extractor on a miss, an
// adapter throw, or an adapter returning low confidence.

import type { SiteAdapter, AdapterResult } from "./types";
import { safeHost } from "./_util";

import { linkedinPublic } from "./linkedinPublic";
import { crunchbasePublic } from "./crunchbasePublic";
import { twitterPublic } from "./twitterPublic";
import { githubPublic } from "./githubPublic";
import { secEdgar } from "./secEdgar";
import { fec } from "./fec";
import { uspto } from "./uspto";
import { companiesHouseUK } from "./companiesHouseUK";
import { openCorporates } from "./openCorporates";
import { wikipedia } from "./wikipedia";
import { wikidata } from "./wikidata";
import { courtListener } from "./courtListener";
import { congressGov } from "./congressGov";
import { pubmed } from "./pubmed";
import { arxiv } from "./arxiv";
import { semanticScholar } from "./semanticScholar";
import { podcastDirectories } from "./podcastDirectories";
import { googleScholarHtml } from "./googleScholarHtml";
import { lawFirmDirectories } from "./lawFirmDirectories";
import { thinkTankRosters } from "./thinkTankRosters";
import { governmentRosters } from "./governmentRosters";
import { venturePartnerListings } from "./venturePartnerListings";
import { CONFERENCE_ADAPTERS } from "./conferenceAdapters";

// Source-of-truth registry. Order is irrelevant — selection is by
// (host match, url pattern match, then priority desc).
export const ADAPTERS: SiteAdapter[] = [
  linkedinPublic, crunchbasePublic, twitterPublic, githubPublic,
  secEdgar, fec, uspto, companiesHouseUK, openCorporates,
  wikipedia, wikidata, courtListener, congressGov,
  pubmed, arxiv, semanticScholar, podcastDirectories,
  googleScholarHtml, lawFirmDirectories,
  thinkTankRosters, governmentRosters, venturePartnerListings,
  ...CONFERENCE_ADAPTERS,
];

/** Returns the highest-priority adapter that claims the URL, or null. */
export function pickAdapter(url: string): SiteAdapter | null {
  const host = safeHost(url);
  if (!host) return null;
  let path = "/";
  let pathWithQuery = "/";
  try {
    const u = new URL(url);
    path = u.pathname;
    pathWithQuery = u.pathname + (u.search || "");
  } catch { /* ignore */ }
  const matches: SiteAdapter[] = [];
  for (const a of ADAPTERS) {
    if (!a.hosts.includes(host)) continue;
    // Adapters may encode their claim in either the path or the
    // query string (e.g. /citations?user=…), so test against both.
    if (a.url_patterns.length
        && !a.url_patterns.some((re) => re.test(path) || re.test(pathWithQuery))) continue;
    matches.push(a);
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.priority - a.priority);
  return matches[0];
}

const MIN_ADAPTER_CONFIDENCE = 0.2;

export interface RunAdapterOutcome {
  result: AdapterResult | null;
  used_adapter_id: string | null;
  fallback_reason: "no_adapter" | "adapter_threw" | "low_confidence" | null;
  adapter_error: string | null;
}

/** Runs the highest-priority adapter for `url`. On throw or low
 *  confidence, returns a `fallback_reason` so the engine knows to fall
 *  back to the generic extractor. A broken adapter must NEVER block the
 *  pipeline. */
export function runAdapter(url: string, html: string): RunAdapterOutcome {
  const adapter = pickAdapter(url);
  if (!adapter) {
    return { result: null, used_adapter_id: null, fallback_reason: "no_adapter", adapter_error: null };
  }
  try {
    const result = adapter.extract(html, url, {});
    if (!result || result.confidence < MIN_ADAPTER_CONFIDENCE) {
      // Drop low-confidence adapter output entirely — the engine will
      // fall back to the generic extractor and ingesting these weak
      // candidates would pollute the dedupe/scoring pipeline.
      return {
        result: null, used_adapter_id: adapter.id,
        fallback_reason: "low_confidence", adapter_error: null,
      };
    }
    return { result, used_adapter_id: adapter.id, fallback_reason: null, adapter_error: null };
  } catch (e) {
    return {
      result: null, used_adapter_id: adapter.id,
      fallback_reason: "adapter_threw", adapter_error: (e as Error).message,
    };
  }
}

export type { SiteAdapter, AdapterResult, AdapterCandidate, AdapterContext } from "./types";
