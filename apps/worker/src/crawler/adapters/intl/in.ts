// Task #3: India — SEBI AIF + MCA21 + RBI NBFC.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<tr[^>]*>[\s\S]*?<td[^>]*>\s*([A-Z][A-Za-z0-9 &.,'-]{3,160}?)\s*<\/td>[\s\S]*?<td[^>]*>\s*(IN\/AIF\/[A-Z0-9\/-]+|U\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "IN", source_id: m[2].trim(), display_name: m[1].trim(),
      kind: "fund", url, confidence: 0.7,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Company|Fund)\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const cin = text.match(/CIN[:\s]+(U\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})/i)?.[1];
  const aifReg = text.match(/(IN\/AIF\/\d{2}-\d{2}\/\d{4}\/\d{4})/i)?.[1];
  const id = cin ?? aifReg;
  if (!name || !id) return null;
  return {
    jurisdiction: "IN", source_id: id, display_name: name,
    kind: aifReg ? "fund" : "company", url, confidence: 0.78,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-z0-9 &.,'-]{2,140})\s+(Circular|Order|Notification|Disclosure)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "IN", source_id: `sebi:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `sebi-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const SEBI = "https://www.sebi.gov.in";

export const inIntl = defineIntlAdapter({
  jurisdiction: "IN", id: "intl_in",
  hosts: ["www.sebi.gov.in", "www.mca.gov.in", "rbi.org.in", "www.rbi.org.in"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: false,
  endpoints: {
    search: (name) => `${SEBI}/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&search=${encodeURIComponent(name)}`,
    company: (id) => `${SEBI}/sebiweb/other/OtherAction.do?doAif=yes&intmId=${encodeURIComponent(id)}`,
    fund: (id) => `${SEBI}/sebiweb/other/OtherAction.do?doAif=yes&intmId=${encodeURIComponent(id)}`,
    filings: (_since) => `${SEBI}/sebiweb/home/HomeAction.do?doListingAll=yes&search=Order`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
