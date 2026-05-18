// Task #3: Canada — CSA National Registration Search + provincial registers.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:firm|registrant)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "CA", source_id: m[1].split(/[\/?]/).pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.65,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Firm|Entity)\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const nrd = text.match(/NRD\s*Number[:\s]+(\d{4,7})/i)?.[1]
    ?? text.match(/Corporation\s*Number[:\s]+(\d{6,9})/i)?.[1];
  if (!name || !nrd) return null;
  return {
    jurisdiction: "CA", source_id: nrd, display_name: name,
    kind: "manager", url, confidence: 0.78,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{4}-\d{2}-\d{2})\s+([A-Z][A-Za-z0-9 &.,'-]{2,140})\s+(Notice|Decision|Order|Registration)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      jurisdiction: "CA", source_id: `csa:${m[1]}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `csa-${m[3].toLowerCase()}`,
      filed_at: m[1], url, data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const CSA = "https://info.securities-administrators.ca";

export const caIntl = defineIntlAdapter({
  jurisdiction: "CA", id: "intl_ca",
  hosts: ["info.securities-administrators.ca", "www.osc.ca", "www.bcsc.bc.ca", "www.asc.ca"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: false,
  endpoints: {
    search: (name) => `${CSA}/nrsmobile/nrssearch/Search.aspx?q=${encodeURIComponent(name)}`,
    company: (id) => `${CSA}/nrsmobile/nrssearch/FirmInfo.aspx?nrd=${encodeURIComponent(id)}`,
    filings: (_since) => `https://www.osc.ca/en/news-events/news`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
