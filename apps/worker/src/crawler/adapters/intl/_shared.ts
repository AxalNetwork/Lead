// Task #3: Shared helpers for intl adapters.
//
// `defineIntlAdapter` packs per-jurisdiction endpoint builders + pure
// parsers into the IntlAdapter orchestrator contract. The orchestrator:
//   1. Builds the per-source URL via the supplied endpoint function.
//   2. Fetches via the crawler engine (crawlerFetch) — robots + throttle
//      enforced upstream.
//   3. Runs the pure parser against the fetched HTML.
//   4. Returns the structured result, surfacing errors to the caller
//      (no broad try/catch — masking parser breakage would defeat the
//      acceptance probes).

import type { Env } from "../../../types";
import type {
  IntlAdapter, IntlEntityHit, IntlFiling, JurisdictionCode,
} from "./types";
import { stripTags as _stripTags } from "../_util";
import { crawlerFetch } from "../../fetcher";

export { stripTags } from "../_util";
export function safeText(html: string): string { return _stripTags(html); }
export function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

/** Pure-parser signatures. Adapters supply these; the factory wires
 *  them through the four orchestrator methods. */
export interface IntlParsers {
  parseSearch?: (html: string, url: string, query: string) => IntlEntityHit[];
  parseCompany?: (html: string, url: string) => IntlEntityHit | null;
  parseFund?: (html: string, url: string) => IntlEntityHit | null;
  parseFilings?: (html: string, url: string, since: string) => IntlFiling[];
}

export interface IntlEndpoints {
  search?: (name: string) => string;
  company?: (id: string) => string;
  fund?: (id: string) => string;
  filings?: (since: string) => string;
}

export interface IntlAdapterSpec {
  jurisdiction: JurisdictionCode;
  id: string;
  hosts: string[];
  throttle: { rps: number; burst: number };
  needs_translation?: boolean;
  endpoints: IntlEndpoints;
  parsers: IntlParsers;
}

async function fetchHtml(env: Env, url: string): Promise<string> {
  const r = await crawlerFetch(env, url);
  if (!r.ok || !r.html) {
    throw new Error(`intl fetch failed: ${url} status=${r.status} err=${r.error ?? "unknown"}`);
  }
  return r.html;
}

export function defineIntlAdapter(spec: IntlAdapterSpec): IntlAdapter {
  const { endpoints, parsers } = spec;
  return {
    jurisdiction: spec.jurisdiction,
    id: spec.id,
    hosts: spec.hosts,
    throttle: spec.throttle,
    needs_translation: spec.needs_translation ?? false,

    async searchEntity(env, name) {
      if (!endpoints.search || !parsers.parseSearch) return [];
      const url = endpoints.search(name);
      const html = await fetchHtml(env, url);
      return parsers.parseSearch(html, url, name);
    },
    async getCompanyProfile(env, source_id) {
      if (!endpoints.company || !parsers.parseCompany) return null;
      const url = endpoints.company(source_id);
      const html = await fetchHtml(env, url);
      return parsers.parseCompany(html, url);
    },
    async getFundProfile(env, source_id) {
      const url = endpoints.fund?.(source_id) ?? endpoints.company?.(source_id);
      const parser = parsers.parseFund ?? parsers.parseCompany;
      if (!url || !parser) return null;
      const html = await fetchHtml(env, url);
      return parser(html, url);
    },
    async streamRecentFilings(env, since) {
      if (!endpoints.filings || !parsers.parseFilings) return [];
      const url = endpoints.filings(since);
      const html = await fetchHtml(env, url);
      return filterSince(parsers.parseFilings(html, url, since), since);
    },

    parsePage(html, url) {
      // Engine integration entry — try parseCompany first, then fall
      // back to parseFund. Parser exceptions are intentionally NOT
      // caught here: the extractor wraps this call and records a
      // structured intl_parse error on result.errors, so swallowing
      // here would defeat that surfacing. Returns null only on a
      // genuine no-match (both parsers returned null).
      return parsers.parseCompany?.(html, url) ?? parsers.parseFund?.(html, url) ?? null;
    },
  };
}

/** Filter filings emitted by a streamRecentFilings parser down to those
 *  newer than `since`. */
export function filterSince(filings: IntlFiling[], since: string): IntlFiling[] {
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return filings;
  return filings.filter((f) => {
    const t = new Date(f.filed_at).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  });
}
