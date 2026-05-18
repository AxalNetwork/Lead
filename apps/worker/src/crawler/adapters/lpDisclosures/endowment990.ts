// Task #2: IRS Form 990 / 990-PF adapter for endowments + foundations.
//
// Source: ProPublica Nonprofit Explorer (https://projects.propublica.org/
// nonprofits/api). The v2 API exposes one JSON document per EIN:
//   GET /nonprofits/api/v2/organizations/{EIN}.json
// → { organization: {ein, name, ...},
//     filings_with_data: [ {tax_prd_yr, totassetsend, totinvstend,
//       invstincmend, totliabend, pdf_url, formtype, ...} ],
//     filings_without_data: [...] }
//
// Per-manager commitment rows live in the linked PDF (Schedule D Part
// XI / Schedule O narrative). When the engine's PDF tier supplies the
// converted text, we parse it through the shared LP-table walker.
// When only the JSON is available, we emit one "anonymized manager
// allocation" row per filing year using `totinvstend` (total
// investments end of year) as the committed-USD signal — preserving
// the spec's "anonymized Manager A/B/C allocations are still captured
// as size signals" requirement.
//
// Pure extractor: JSON parse → emit rows; on parse failure (HTML page),
// fall back to text parsing.

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload, LpCommitmentCandidate, LpClass } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

interface PropublicaFiling {
  tax_prd?: string | number;
  tax_prd_yr?: string | number;
  pdf_url?: string;
  formtype?: number | string;
  // Investment-related fields (subset; ProPublica exposes ~250).
  totassetsend?: number | string;
  totinvstend?: number | string;
  invstincmend?: number | string;
  totliabend?: number | string;
}

interface PropublicaPayload {
  organization?: {
    ein?: string | number;
    name?: string;
    sub_name?: string;
    ntee_code?: string;
    classification?: string;
  };
  filings_with_data?: PropublicaFiling[];
  filings_without_data?: PropublicaFiling[];
}

function tryParseJson(content: string): PropublicaPayload | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed as PropublicaPayload : null;
  } catch { return null; }
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s$]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function periodEndIso(f: PropublicaFiling): string | null {
  // tax_prd is YYYYMM (period end); tax_prd_yr is the calendar year.
  const tp = String(f.tax_prd ?? "").trim();
  if (/^\d{6}$/.test(tp)) {
    const yyyy = tp.slice(0, 4);
    const mm = tp.slice(4, 6);
    return `${yyyy}-${mm}-30`; // approximate; period-end day varies
  }
  const yr = toNumber(f.tax_prd_yr);
  if (yr) return `${Math.trunc(yr)}-12-31`;
  return null;
}

/**
 * NTEE / classification → LP class. Universities (B40-B50) are
 * endowments; private foundations (NTEE-T, formtype=4) are
 * foundations; everything else falls through to 'other'.
 */
function classifyLp(org: PropublicaPayload["organization"], latest?: PropublicaFiling): LpClass {
  const ntee = (org?.ntee_code ?? "").toUpperCase();
  const ft = Number(latest?.formtype ?? 0);
  if (ft === 4 || ntee.startsWith("T")) return "foundation";
  if (ntee.startsWith("B4") || ntee.startsWith("B5")) return "endowment";
  if (/college|university|institute of technology|endowment/i.test(org?.name ?? "")) return "endowment";
  return "other";
}

function extractFromJson(parsed: PropublicaPayload, url: string): AdapterResult {
  const org = parsed.organization;
  const ein = String(org?.ein ?? "").replace(/\D/g, "");
  const display_name = org?.name ?? "Unknown 990 filer";
  const slug = ein ? `irs_990_${ein}` : `irs_990_unknown`;
  const filings = parsed.filings_with_data ?? [];
  const lp_class = classifyLp(org, filings[0]);

  // One commitment row per (filing year, "anonymized manager
  // allocation"). The row uses totinvstend as the committed-USD size
  // signal — for a 990-PF this is the aggregate of all PE / fund
  // holdings at period end. Schedule D / Schedule O parsing in the
  // linked PDF lives in endowmentAnnual (downstream URL).
  const commitments: LpCommitmentCandidate[] = [];
  for (const f of filings) {
    const period = periodEndIso(f);
    if (!period) continue;
    const inv = toNumber(f.totinvstend);
    const asset = toNumber(f.totassetsend);
    const committed = inv ?? asset;
    if (committed == null) continue;
    commitments.push({
      fund_name_raw: `Anonymous manager allocation FY${period.slice(0, 4)}`,
      vintage_year: Number(period.slice(0, 4)),
      committed_usd: committed,
      called_usd: committed,
      distributed_usd: null,
      nav_usd: committed,
      net_irr_pct: null,
      tvpi: null,
      dpi: null,
      gp_firm_hint: null,
    });
  }

  const latestPeriod = filings.length ? periodEndIso(filings[0]) : null;
  const payload: LpDisclosurePayload = {
    lp_slug: slug,
    lp_display_name: display_name,
    lp_class,
    as_of_date: latestPeriod,
    filing_date: latestPeriod,
    source_url: url,
    commitments,
  };
  const conf = commitments.length > 0 ? 0.7 : 0.3;
  return {
    adapter_id: "lp_endowment_990",
    confidence: conf,
    candidates: [{
      profile_type: "lp_disclosure",
      confidence: conf,
      name: display_name,
      url,
      data: payload as unknown as Record<string, unknown>,
    }],
    child_urls: filings.map((f) => f.pdf_url).filter((u): u is string => !!u).slice(0, 25),
    notes: { ein, filing_count: filings.length, row_count: commitments.length, lp_class },
  };
}

function extractFromHtml(content: string, url: string): AdapterResult {
  const text = toText(content);
  const as_of_date = findAsOfDate(text.slice(0, 6000));
  const commitments = parseLpTable(text);
  // Best-effort name extraction from the HTML title.
  const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
  const display_name = (titleMatch?.[1] ?? "").trim().replace(/\s+\|\s+nonprofit explorer.*$/i, "") || "Unknown 990 filer";
  const slugSeed = url.replace(/[^a-z0-9]/gi, "").slice(-24);
  const payload: LpDisclosurePayload = {
    lp_slug: `irs_990_${slugSeed}`,
    lp_display_name: display_name,
    lp_class: "foundation",
    as_of_date,
    filing_date: as_of_date,
    source_url: url,
    commitments,
  };
  const conf = commitments.length > 0 ? 0.5 : 0.2;
  return {
    adapter_id: "lp_endowment_990",
    confidence: conf,
    candidates: [{
      profile_type: "lp_disclosure",
      confidence: conf,
      name: display_name,
      url,
      data: payload as unknown as Record<string, unknown>,
    }],
    child_urls: [],
    notes: { row_count: commitments.length, as_of_date, parsed_as: "html" },
  };
}

function extract990(content: string, url: string): AdapterResult {
  const json = tryParseJson(content);
  if (json && (json.organization || json.filings_with_data)) {
    return extractFromJson(json, url);
  }
  return extractFromHtml(content, url);
}

export const endowment990: SiteAdapter = {
  id: "lp_endowment_990",
  priority: 55,
  hosts: ["projects.propublica.org"],
  // Cover both the v2 JSON API and the HTML browse pages.
  // v2 JSON:  /nonprofits/api/v2/organizations/{EIN}.json
  // HTML:     /nonprofits/organizations/{EIN}
  url_patterns: [
    /\/nonprofits\/api\/v\d+\/organizations?\/\d+(?:\.json)?$/i,
    /\/nonprofits\/api\/organizations?\/\d+(?:\.json)?$/i,
    /\/nonprofits\/organizations?\/\d+/i,
  ],
  profile_types_emitted: ["lp_disclosure"],
  extract: extract990,
};
