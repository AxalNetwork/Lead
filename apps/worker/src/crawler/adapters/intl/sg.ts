// Task #3: Singapore — MAS Financial Institutions Directory + ACRA BizFile.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  // MAS directory rows: institution name + MAS register id.
  const re = /<a[^>]+href=["']([^"']*Institution[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "SG", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.7,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Entity\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim()
    ?? text.match(/Institution\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const uen = text.match(/UEN[:\s]+(\d{8,9}[A-Z]|[TS]\d{2}[A-Z]{2}\d{4}[A-Z])/i)?.[1];
  if (!name || !uen) return null;
  return {
    jurisdiction: "SG", source_id: uen, display_name: name,
    kind: "manager", url, confidence: 0.85,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+([A-Z][A-Za-z0-9 &.,'-]{2,140})\s+(Notice|Circular|Consultation|Licence)/gi;
  const monthMap: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = m[1].split(/\s+/);
    const dd = parts[0].padStart(2, "0");
    const mm = monthMap[parts[1].slice(0, 3).toLowerCase()];
    const yy = parts[2];
    if (!mm) continue;
    out.push({
      jurisdiction: "SG", source_id: `mas:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `mas-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const sgIntl = defineIntlAdapter({
  jurisdiction: "SG", id: "intl_sg",
  hosts: ["eservices.mas.gov.sg", "www.mas.gov.sg", "www.bizfile.gov.sg", "data.gov.sg"],
  throttle: { rps: 2, burst: 5 },
  needs_translation: false,
  parseSearch, parseCompany, parseFilings,
});
