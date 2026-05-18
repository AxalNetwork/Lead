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
    // BaFin prospectuses commonly disclose the management company as
    // "Kapitalverwaltungsgesellschaft: <NAME> (BaFin-ID: NNNNNN)".
    // When present, emit the canonical-firm linkage so the same
    // canonical_firm_entity_id collects every German vehicle.
    const start = Math.max(0, m.index - 80);
    const end = Math.min(text.length, m.index + m[0].length + 240);
    const win = text.slice(start, end);
    const kvg = /Kapitalverwaltungsgesellschaft[:\s]+([A-Z][A-Za-zÀ-ÿ0-9 &.,'-]{2,120}?)\s*\(?BaFin[\s-]*ID[:\s]+(\d{6,12})\)?/i.exec(win);
    const data: Record<string, unknown> = {};
    if (kvg) {
      data.canonical_firm_source_id = kvg[2];
      data.canonical_firm_display_name = kvg[1].trim();
      data.vehicle_role = "management_company";
    }
    out.push({
      jurisdiction: "DE", source_id: `bafin:${yy}-${mm}-${dd}:${m[2].slice(0, 40)}`,
      filer_name: m[2].trim(), filing_type: `bafin-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "de", original_text: m[0], english_text: null,
      data, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const BAFIN = "https://portal.mvp.bafin.de";

export const deIntl = defineIntlAdapter({
  jurisdiction: "DE", id: "intl_de",
  hosts: ["portal.mvp.bafin.de", "www.bafin.de", "www.unternehmensregister.de"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  endpoints: {
    search: (name) => `${BAFIN}/database/InstInfo/sucheForm.do?cmd=sucheNeu&searchString=${encodeURIComponent(name)}`,
    company: (id) => `${BAFIN}/database/InstInfo/details.do?inst=${encodeURIComponent(id)}`,
    filings: (_since) => `https://www.bafin.de/SiteGlobals/Forms/Suche/EN/Konsultationssuche_Formular.html`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
