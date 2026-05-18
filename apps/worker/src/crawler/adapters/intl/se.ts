// Task #3: Sweden — Finansinspektionen + Bolagsverket.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*foretag[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "SE", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6, original_lang: "sv",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Företagsnamn[:\s]+([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const orgno = text.match(/Organisationsnummer[:\s]+(\d{6}-?\d{4})/i)?.[1]?.replace(/-/g, "");
  if (!name || !orgno) return null;
  return {
    jurisdiction: "SE", source_id: orgno, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "sv",
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{4}-\d{2}-\d{2})\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö0-9 &.,'-]{2,140})\s+(Beslut|Tillstånd|Prospekt)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      jurisdiction: "SE", source_id: `fi:${m[1]}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `fi-${m[3].toLowerCase()}`,
      filed_at: m[1], url,
      original_lang: "sv", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const seIntl = defineIntlAdapter({
  jurisdiction: "SE", id: "intl_se",
  hosts: ["www.fi.se", "www.bolagsverket.se"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
