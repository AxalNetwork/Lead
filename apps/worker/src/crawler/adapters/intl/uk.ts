// Task #3: UK adapter — Companies House + FCA + British Business Bank.
//
// Wraps (does NOT replace) the existing flat companiesHouseUK.ts so
// engine routing for /company/* URLs still finds the legacy adapter.
// The IntlAdapter shape is the operator-facing API; the legacy adapter
// remains the SiteAdapter the crawler engine routes to.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import { companiesHouseUK } from "../companiesHouseUK";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseCompany(html: string, url: string): IntlEntityHit | null {
  // Delegate the heavy lifting to the existing flat adapter, then pack
  // the candidate into the Intl shape.
  const r = companiesHouseUK.extract(html, url, {});
  const c = r.candidates[0];
  if (!c || !c.data || !c.data.company_number) return null;
  return {
    jurisdiction: "UK",
    source_id: String(c.data.company_number),
    display_name: c.name ?? String(c.data.company_name ?? ""),
    kind: "company",
    url,
    confidence: c.confidence,
  };
}

function parseSearch(html: string, _url: string, _query: string): IntlEntityHit[] {
  // Companies House search results table: rows with /company/XXXXXXXX
  const hits: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']\/company\/([A-Z0-9]+)["'][^>]*>\s*([^<]+?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    hits.push({
      jurisdiction: "UK", source_id: m[1].toUpperCase(),
      display_name: m[2].trim(), kind: "company",
      url: `https://find-and-update.company-information.service.gov.uk/company/${m[1]}`,
      confidence: 0.7,
    });
    if (hits.length >= 25) break;
  }
  return hits;
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  // FCA register publication index — table of recent notices.
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const rowRe = /(\d{4}-\d{2}-\d{2})\s+([A-Z0-9-]+)\s+([A-Z][A-Za-z0-9 &.,'-]{2,120})/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text))) {
    out.push({
      jurisdiction: "UK", source_id: m[2], filer_name: m[3].trim(),
      filing_type: "fca-register-update", filed_at: m[1], url,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const CH = "https://find-and-update.company-information.service.gov.uk";
const FCA = "https://register.fca.org.uk";

export const ukIntl = defineIntlAdapter({
  jurisdiction: "UK", id: "intl_uk",
  hosts: [
    "find-and-update.company-information.service.gov.uk",
    "register.fca.org.uk",
    "british-business-bank.co.uk",
    "www.gov.uk",
  ],
  throttle: { rps: 2, burst: 5 }, // Companies House free tier: 600/5min ~ 2 rps.
  needs_translation: false,
  endpoints: {
    search: (name) => `${CH}/search/companies?q=${encodeURIComponent(name)}`,
    company: (id) => `${CH}/company/${encodeURIComponent(id)}`,
    filings: (_since) => `${FCA}/s/search?q=*&type=Notice`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
