// Task #3: France — AMF GECO + Infogreffe.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:societe|geco)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "FR", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6, original_lang: "fr",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Dénomination\s*sociale[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const siren = text.match(/SIREN[:\s]+(\d{3}\s?\d{3}\s?\d{3})/i)?.[1]?.replace(/\s/g, "");
  if (!name || !siren) return null;
  return {
    jurisdiction: "FR", source_id: siren, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "fr", display_name_original: name,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,140})\s+(Prospectus|Visa|Décision|Agrément)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "FR", source_id: `amf:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `amf-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "fr", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const frIntl = defineIntlAdapter({
  jurisdiction: "FR", id: "intl_fr",
  hosts: ["geco.amf-france.org", "www.amf-france.org", "www.infogreffe.fr"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
