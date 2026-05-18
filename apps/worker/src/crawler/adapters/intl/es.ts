// Task #3: Spain — CNMV.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:Registro|Entidad)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "ES", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.55, original_lang: "es",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Denominación\s*social[:\s]+([A-Z][A-Za-zÁ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const nif = text.match(/(?:NIF|CIF)[:\s]+([A-Z]\d{8}|\d{8}[A-Z])/i)?.[1];
  if (!name || !nif) return null;
  return {
    jurisdiction: "ES", source_id: nif, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "es",
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-zÁ-ÿ0-9 &.,'-]{2,140})\s+(Folleto|Hecho\s+relevante|Inscripción)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "ES", source_id: `cnmv:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `cnmv-${m[3].toLowerCase().replace(/\s+/g,"_")}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "es", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const CNMV = "https://www.cnmv.es";

export const esIntl = defineIntlAdapter({
  jurisdiction: "ES", id: "intl_es",
  hosts: ["www.cnmv.es"],
  throttle: { rps: 0.5, burst: 2 }, // CNMV HTML index is slow.
  needs_translation: true,
  endpoints: {
    search: (name) => `${CNMV}/portal/Consultas/BusquedaPorEntidad.aspx?nombre=${encodeURIComponent(name)}`,
    company: (id) => `${CNMV}/portal/Consultas/EE/InformacionEntidad.aspx?nif=${encodeURIComponent(id)}`,
    filings: (_since) => `${CNMV}/portal/HR/UltimasHR.aspx`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
