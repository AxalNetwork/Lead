// Task #3: EU/ESMA adapter — cross-border AIFM + UCITS managers.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, _url: string, _q: string): IntlEntityHit[] {
  // ESMA register search results — manager rows keyed by LEI / register id.
  const out: IntlEntityHit[] = [];
  const re = /<tr[^>]*>[\s\S]*?<td[^>]*>([^<]+?)<\/td>[\s\S]*?<td[^>]*>([A-Z0-9]{10,20})<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "EU", source_id: m[2].trim(), display_name: m[1].trim(),
      kind: "manager", url: _url, confidence: 0.6,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Entity\s*name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,150})/i)?.[1]?.trim();
  const lei = text.match(/LEI[:\s]+([A-Z0-9]{20})/i)?.[1]
    ?? url.match(/[?&]lei=([A-Z0-9]{20})/i)?.[1];
  if (!name || !lei) return null;
  return { jurisdiction: "EU", source_id: lei, display_name: name, kind: "manager", url, confidence: 0.75 };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  // ESMA "latest publications" RSS-style table.
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{4}-\d{2}-\d{2})\s+([A-Z][A-Za-z0-9 &.,'-]{2,120})\s+(AIFMD|UCITS|EMIR|MAR|MiFID)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      jurisdiction: "EU", source_id: `esma:${m[1]}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `esma-${m[3].toLowerCase()}`,
      filed_at: m[1], url, data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const euEsmaIntl = defineIntlAdapter({
  jurisdiction: "EU", id: "intl_eu_esma",
  hosts: ["registers.esma.europa.eu", "www.esma.europa.eu"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: false,
  parseSearch, parseCompany, parseFilings,
});
