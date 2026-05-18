// Task #3: Netherlands — AFM register + KVK.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:register|onderneming)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "NL", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6, original_lang: "nl",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Statutaire\s*naam[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim()
    ?? text.match(/Handelsnaam[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const kvk = text.match(/KvK[\s-]*nummer[:\s]+(\d{8})/i)?.[1]
    ?? text.match(/Chamber\s*of\s*Commerce\s*number[:\s]+(\d{8})/i)?.[1];
  if (!name || !kvk) return null;
  return {
    jurisdiction: "NL", source_id: kvk, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "nl",
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}-\d{2}-\d{4})\s+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,140})\s+(Prospectus|Vergunning|Mededeling)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("-");
    out.push({
      jurisdiction: "NL", source_id: `afm:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `afm-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "nl", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const nlIntl = defineIntlAdapter({
  jurisdiction: "NL", id: "intl_nl",
  hosts: ["www.afm.nl", "www.kvk.nl"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
