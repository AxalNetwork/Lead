// Task #3: Singapore — MAS Financial Institutions Directory + ACRA BizFile.

import { defineIntlAdapter, safeText, filterSince } from "./_shared";
import type { IntlEntityHit, IntlFiling } from "./types";

function parseSearch(html: string, url: string): IntlEntityHit[] {
  const out: IntlEntityHit[] = [];
  // MAS directory rows: institution name + MAS register id.
  const re = /<a[^>]+href=["']([^"']*Institution[^"']+)["'][^>]*>\s*([^<]{3,160})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      jurisdiction: "SG", source_id: m[1].split("/").pop() ?? m[1],
      display_name: m[2].trim(), kind: "manager",
      url: new URL(m[1], url).toString(), confidence: 0.7,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function parseCompany(html: string, url: string): IntlEntityHit | null {
  const text = safeText(html);
  const name = text.match(/Entity\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim()
    ?? text.match(/Institution\s*Name[:\s]+([A-Z][A-Za-z0-9 &.,'-]{2,160})/i)?.[1]?.trim();
  const uen = text.match(/UEN[:\s]+(\d{8,9}[A-Z]|[TS]\d{2}[A-Z]{2}\d{4}[A-Z])/i)?.[1];
  if (!name || !uen) return null;
  return {
    jurisdiction: "SG", source_id: uen, display_name: name,
    kind: "manager", url, confidence: 0.85,
  };
}

/** Pull a {raw_amount, raw_currency} from the local context around a
 *  filing row. MAS notices often include the fund size or AUM as
 *  "SGD 50 million" / "USD 1.2 billion" — adapters that surface those
 *  let persistIntlFiling call toUsd. */
function extractAmount(window: string): { raw_amount: number | null; raw_currency: string | null } {
  const m = /\b(SGD|USD|EUR|HKD|CNY|JPY|GBP)\s*([\d,]+(?:\.\d+)?)\s*(million|billion|m|bn)?\b/i.exec(window);
  if (!m) return { raw_amount: null, raw_currency: null };
  const cur = m[1].toUpperCase();
  let n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return { raw_amount: null, raw_currency: null };
  const mag = m[3]?.toLowerCase();
  if (mag === "million" || mag === "m") n *= 1_000_000;
  else if (mag === "billion" || mag === "bn") n *= 1_000_000_000;
  return { raw_amount: n, raw_currency: cur };
}

function parseFilings(html: string, url: string, since: string): IntlFiling[] {
  const out: IntlFiling[] = [];
  const text = safeText(html);
  const re = /(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+([A-Z][A-Za-z0-9 &.,'-]{2,140})\s+(Notice|Circular|Consultation|Licence)/gi;
  const monthMap: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = m[1].split(/\s+/);
    const dd = parts[0].padStart(2, "0");
    const mm = monthMap[parts[1].slice(0, 3).toLowerCase()];
    const yy = parts[2];
    if (!mm) continue;
    // Pull a small context window for amount extraction.
    const start = Math.max(0, m.index - 80);
    const end = Math.min(text.length, m.index + m[0].length + 200);
    const { raw_amount, raw_currency } = extractAmount(text.slice(start, end));
    // "Managed by" pattern → bind this fund vehicle to a canonical
    // firm in the next persist step. MAS notices commonly include
    // "managed by <NAME> (UEN: XXXXXXXX)" — when we see it, emit the
    // canonical_firm_source_id + vehicle_role so persist's
    // maybeLinkVehicle can call linkVehicleToCanonicalFirm.
    const mgr = /managed\s+by\s+([A-Z][A-Za-z0-9 &.,'-]{2,120}?)\s*\(?UEN[:\s]+(\d{8,9}[A-Z]|[TS]\d{2}[A-Z]{2}\d{4}[A-Z])\)?/i
      .exec(text.slice(start, end));
    const data: Record<string, unknown> = {};
    if (mgr) {
      data.canonical_firm_source_id = mgr[2];
      data.canonical_firm_display_name = mgr[1].trim();
      data.vehicle_role = "management_company";
    }
    out.push({
      jurisdiction: "SG", source_id: `mas:${yy}-${mm}-${dd}:${m[2].slice(0,40)}`,
      filer_name: m[2].trim(), filing_type: `mas-${m[3].toLowerCase()}`,
      filed_at: `${yy}-${mm}-${dd}`, url,
      raw_amount, raw_currency,
      data, source_evidence_json: { row: m[0], window: text.slice(start, end) },
    });
    if (out.length >= 100) break;
  }
  return filterSince(out, since);
}

const MAS = "https://eservices.mas.gov.sg";

export const sgIntl = defineIntlAdapter({
  jurisdiction: "SG", id: "intl_sg",
  hosts: ["eservices.mas.gov.sg", "www.mas.gov.sg", "www.bizfile.gov.sg", "data.gov.sg"],
  throttle: { rps: 2, burst: 5 },
  needs_translation: false,
  endpoints: {
    search: (name) => `${MAS}/fid/institution/search?name=${encodeURIComponent(name)}`,
    company: (id) => `${MAS}/fid/institution/${encodeURIComponent(id)}`,
    filings: (since) => `https://www.mas.gov.sg/news?content_type=Media%20Release&from_date=${encodeURIComponent(since)}`,
  },
  parsers: { parseSearch, parseCompany, parseFilings },
});
