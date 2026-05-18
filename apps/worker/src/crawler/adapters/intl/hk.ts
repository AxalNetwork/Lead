// Task #3: Hong Kong — SFC public register + Companies Registry.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:publicregWeb|company)[^"']+)["'][^>]*>\s*([^<]{2,200})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "HK", source_id: m[1].split(/[\/?]/).pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Corporation\s*Name|Entity\s*Name)[:\s]+([A-Z][A-Za-z0-9 &.,'()-]{2,200})/i)?.[1]?.trim();
  const ce = text.match(/CE\s*Number[:\s]+([A-Z]{3}\d{3,4})/i)?.[1]
    ?? text.match(/CR\s*Number[:\s]+(\d{4,8})/i)?.[1];
  if (!name || !ce) return null;
  return {
    jurisdiction: "HK", source_id: ce, display_name: name,
    kind: "manager", url, confidence: 0.78,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+([A-Z][A-Za-z0-9 &.,'()-]{2,140})\s+(Circular|Statement|Decision)/gi;
  const monthMap: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = m[1].split(/\s+/);
    const mm = monthMap[parts[1].slice(0, 3).toLowerCase()];
    if (!mm) continue;
    const filed_at = `${parts[2]}-${mm}-${parts[0].padStart(2, "0")}`;
    out.push({
      jurisdiction: "HK", source_id: `sfc:${filed_at}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `sfc-${m[3].toLowerCase()}`,
      filed_at, url, data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const hkIntl = defineIntlAdapter({
  jurisdiction: "HK", id: "intl_hk",
  hosts: ["www.sfc.hk", "apps.sfc.hk", "www.cr.gov.hk"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: false,
  parseSearch, parseCompany, parseFilings,
});
