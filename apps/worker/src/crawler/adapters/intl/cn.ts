// Task #3: China — AMAC PE/VC manager registry + SAMR + CSRC.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  const re = /<a[^>]+href=["']([^"']*(?:manager|gsdtList)[^"']+)["'][^>]*>\s*([^<]{2,200})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[2].trim();
    out.push({
      jurisdiction: "CN", source_id: m[1].split(/[\/?]/).pop() ?? m[1],
      display_name: name, kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.6,
      original_lang: "zh", display_name_original: name,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/(?:管理人名称|私募基金管理人名称)[:：\s]*([^\s<]{2,160})/)?.[1]?.trim()
    ?? text.match(/Manager\s*Name[:\s]+([^\n<]{2,160})/i)?.[1]?.trim();
  const id = text.match(/(?:登记编号|Registration\s*No\.?)[:：\s]*([A-Z0-9]{6,20})/i)?.[1];
  if (!name || !id) return null;
  return {
    jurisdiction: "CN", source_id: id, display_name: name,
    kind: "manager", url, confidence: 0.78,
    original_lang: "zh", display_name_original: name,
  };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  // CN dates: YYYY-MM-DD or YYYY年MM月DD日
  const re = /(\d{4}[-年]\s*\d{1,2}[-月]\s*\d{1,2}日?)\s+([^\s][^\n]{2,140}?)\s+(公告|通知|备案|登记)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = m[1].match(/(\d{4})[-年]\s*(\d{1,2})[-月]\s*(\d{1,2})/);
    if (!parts) continue;
    const filed_at = `${parts[1]}-${parts[2].padStart(2,"0")}-${parts[3].padStart(2,"0")}`;
    out.push({
      jurisdiction: "CN", source_id: `amac:${filed_at}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `amac-${m[3]}`,
      filed_at, url,
      original_lang: "zh", original_text: m[0], english_text: null,
      data: {}, source_evidence_json: { row: m[0] },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

export const cnIntl = defineIntlAdapter({
  jurisdiction: "CN", id: "intl_cn",
  hosts: ["gs.amac.org.cn", "www.amac.org.cn", "www.csrc.gov.cn", "www.samr.gov.cn"],
  throttle: { rps: 0.5, burst: 2 },
  needs_translation: true,
  parseSearch, parseCompany, parseFilings,
});
