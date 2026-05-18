// Task #3: Shared helpers for intl adapters.
//
// Tiny HTML/regex helpers + a factory that turns a per-jurisdiction
// extractor pair into the IntlAdapter contract. Keeps adapter files
// thin (each file is ~50-80 lines) and prevents the four-method
// boilerplate from being repeated 17 times.

import type { IntlAdapter, IntlEntityHit, IntlFiling, JurisdictionCode } from "./types";
import { stripTags as _stripTags } from "../_util";

export { stripTags } from "../_util";

export function pickAll(html: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = r.exec(html))) out.push(m[1] ?? m[0]);
  return out;
}

export function safeText(html: string): string { return _stripTags(html); }

export function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

/** Common builder for an IntlAdapter. Per-jurisdiction files declare
 *  their hosts + throttle + the three parse functions; this packs them
 *  into the four-method contract with sensible defaults. */
export function defineIntlAdapter(spec: {
  jurisdiction: JurisdictionCode;
  id: string;
  hosts: string[];
  throttle: { rps: number; burst: number };
  needs_translation?: boolean;
  parseSearch?: (html: string, url: string, query: string) => IntlEntityHit[];
  parseCompany?: (html: string, url: string) => IntlEntityHit | null;
  parseFund?: (html: string, url: string) => IntlEntityHit | null;
  parseFilings?: (html: string, url: string, since: string) => IntlFiling[];
}): IntlAdapter {
  return {
    jurisdiction: spec.jurisdiction,
    id: spec.id,
    hosts: spec.hosts,
    throttle: spec.throttle,
    needs_translation: spec.needs_translation ?? false,
    async searchEntity(html, url, query) {
      try { return spec.parseSearch?.(html, url, query) ?? []; } catch { return []; }
    },
    async getCompanyProfile(html, url) {
      try { return spec.parseCompany?.(html, url) ?? null; } catch { return null; }
    },
    async getFundProfile(html, url) {
      try { return spec.parseFund?.(html, url) ?? null; } catch { return null; }
    },
    async streamRecentFilings(html, url, since) {
      try { return spec.parseFilings?.(html, url, since) ?? []; } catch { return []; }
    },
  };
}

/** Filter filings emitted by a streamRecentFilings parser down to those
 *  newer than `since`. Adapters call this so the contract semantic is
 *  identical across jurisdictions. */
export function filterSince(filings: IntlFiling[], since: string): IntlFiling[] {
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return filings;
  return filings.filter((f) => {
    const t = new Date(f.filed_at).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  });
}
