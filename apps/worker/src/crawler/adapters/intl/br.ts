// Task #3: Brazil — CVM registries + Receita Federal CNPJ lookup.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:participantes|consulta)[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "BR", source_id: m[1].split(/[\/?]/).pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6,
      original_lang: "pt",
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:Razão\s*Social|Nome\s*Empresarial)[:\s]+([A-Z][A-Za-zÁ-ÿ0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const cnpj = text.match(/CNPJ[:\s]+(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/i)?.[1]?.replace(/[^\d]/g, "");
  if (!name || !cnpj) return null;
  return {
    jurisdiction: "BR", source_id: cnpj, display_name: name,
    kind: "company", url, confidence: 0.78, original_lang: "pt",
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{2}\/\d{2}\/\d{4})\s+([A-Z][A-Za-zÁ-ÿ0-9 &.,'-]{2,140})\s+(Comunicado|Aviso|Fato\s*Relevante|Deliberação)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [dd, mm, yy] = m[1].split("/");
    out.push({
      jurisdiction: "BR", source_id: `cvm:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `cvm-${m[3].toLowerCase().replace(/\s+/g,"_")}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      original_lang: "pt", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const brIntl = defineIntlAdapter({
  jurisdiction: "BR", id: "intl_br",
  hosts: ["www.cvm.gov.br", "sistemas.cvm.gov.br", "servicos.receita.fazenda.gov.br"],
  throttle: { rps: 1, burst: 3 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
