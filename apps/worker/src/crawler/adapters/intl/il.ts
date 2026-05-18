// Task #3: Israel — ISA registers + Rashut HaTaagidim.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:company|hevra|fund)[^"']+)["'][^>]*>\s*([^<]{2,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "IL", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.5,
      original_lang: /[\u0590-\u05ff]/.test(m[2]) ? "he" : "en",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Company\s*Name|שם\s*חברה)[:\s]+([^\n<]{2,160})/i)?.[1]?.trim();
  const num = text.match(/(?:Company\s*Number|מספר\s*חברה)[:\s]+(\d{8,12})/i)?.[1];
  if (!name || !num) return null;
  const hebrew = /[\u0590-\u05ff]/.test(name);
  return {
    jurisdiction: "IL", source_id: num, display_name: name,
    kind: "company", url, confidence: 0.78,
    original_lang: hebrew ? "he" : "en",
    display_name_original: hebrew ? name : null,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  // IL ISA uses DD.MM.YYYY (Hebrew convention).
  const re = /(\d{2}\.\d{2}\.\d{4})\s+([^\s][^\n]{2,140}?)\s+(Prospectus|Immediate|תשקיף|דיווח)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split(".");
    const hebrew = /[\u0590-\u05ff]/.test(m[0]);
    out.push({
      jurisdiction: "IL", source_id: `isa:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `isa-${m[3].toLowerCase().replace(/[\u0590-\u05ff]/g,"_")}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: hebrew ? "he" : "en",
      original_text: hebrew ? m[0] : null, english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const MAGNA = "https://magna.isa.gov.il";

export const ilIntl = defineIntlAdapter({
  jurisdiction: "IL", id: "intl_il",
  hosts: ["www.isa.gov.il", "magna.isa.gov.il", "www.gov.il"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  endpoints: {
    search: (name) => `${MAGNA}/Pages/SearchResults.aspx?k=${encodeURIComponent(name)}`,
    company: (id) => `${MAGNA}/CompanyDetails.aspx?CompanyId=${encodeURIComponent(id)}`,
    filings: (_since) => `${MAGNA}/Pages/Reports.aspx`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
