// Task #3: Germany — BaFin public register + Unternehmensregister.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*\/(?:institut|fonds|manager)\/[^"']+)["'][^>]*>\s*([^<]+?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "DE", source_id: m[1].split("/").pop() || m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6,
      original_lang: "de",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Firmenname[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,150})/i)?.[1]?.trim()
    ?? text.match(/Name\s*des\s*Instituts[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,150})/i)?.[1]?.trim();
  const id = text.match(/BaFin[\s-]*ID[:\s]+(\d{6,12})/i)?.[1]
    ?? text.match(/HRB\s+(\d{3,9})/i)?.[1];
  if (!name || !id) return null;
  return {
    jurisdiction: "DE", source_id: id, display_name: name, kind: "manager",
    url, confidence: 0.75, original_lang: "de", display_name_original: name,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\.\d{2}\.\d{4})\s+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,120})\s+(Prospekt|Mitteilung|Anzeige|Bescheid)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split(".");
    out.push({
      jurisdiction: "DE", source_id: `bafin:${yy}-${mm}-${dd}:${m[2].slice(0, 40)}`,
      filer_name: m[2].trim(), filing_type: `bafin-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "de", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const deIntl = defineIntlAdapter({
  jurisdiction: "DE", id: "intl_de",
  hosts: ["portal.mvp.bafin.de", "www.bafin.de", "www.unternehmensregister.de"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
