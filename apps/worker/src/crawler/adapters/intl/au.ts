// Task #3: Australia — ASIC registers + AUSTRAC.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:organisation|company)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "AU", source_id: m[1].split(/[\/?]/).pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.65,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Company|Organisation)\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const acn = text.match(/ACN[:\s]+(\d{3}\s?\d{3}\s?\d{3})/i)?.[1]?.replace(/\s/g, "")
    ?? text.match(/ABN[:\s]+(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})/i)?.[1]?.replace(/\s/g, "");
  if (!name || !acn) return null;
  return {
    jurisdiction: "AU", source_id: acn, display_name: name,
    kind: "company", url, confidence: 0.78,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-z0-9 &.,'-]{2,140})\s+(Notice|Disclosure|Lodgement|Prospectus)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "AU", source_id: `asic:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `asic-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const ASIC = "https://connectonline.asic.gov.au";

export const auIntl = defineIntlAdapter({
  jurisdiction: "AU", id: "intl_au",
  hosts: ["asic.gov.au", "connectonline.asic.gov.au", "www.austrac.gov.au"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: false,
  endpoints: {
    search: (name) => `${ASIC}/RegistrySearch/faces/landing/SearchRegisters.jspx?searchText=${encodeURIComponent(name)}`,
    company: (id) => `${ASIC}/RegistrySearch/faces/landing/panelSearch.jspx?searchText=${encodeURIComponent(id)}`,
    filings: (_since) => `https://asic.gov.au/about-asic/news-centre/news-items/`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
