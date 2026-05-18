// Task #3: Italy — CONSOB.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:Albo|Soggetto)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "IT", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.55, original_lang: "it",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Denominazione[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const cf = text.match(/Codice\s*fiscale[:\s]+(\d{11}|[A-Z0-9]{16})/i)?.[1];
  if (!name || !cf) return null;
  return {
    jurisdiction: "IT", source_id: cf, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "it",
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,140})\s+(Prospetto|Comunicazione|Provvedimento)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "IT", source_id: `consob:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `consob-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "it", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const itIntl = defineIntlAdapter({
  jurisdiction: "IT", id: "intl_it",
  hosts: ["www.consob.it"],
  throttle: { rps: 0.5, burst: 2 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
