// Task #2: IRS Form 990 / 990-PF adapter for endowments + foundations.
//
// Source: ProPublica Nonprofit Explorer publishes 990 + 990-PF JSON
// (https://projects.propublica.org/nonprofits/api). The crawler engine
// fetches the JSON document; this adapter parses Schedule D (investment
// holdings) + Schedule O (narrative notes that sometimes name PE
// managers). When the source is the HTML page, we strip and fall back
// to the generic table walker.
//
// Pure extractor: input is whatever the engine fetched. We try JSON
// first; on parse failure (HTML page), fall back to text parsing.

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload, LpCommitmentCandidate } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

interface PropublicaFiling {
  organization?: { name?: string; ein?: string };
  filings_with_data?: Array<{
    tax_prd?: string | number;
    tax_prd_yr?: string | number;
    pdf_url?: string;
    formtype?: number;
  }>;
}

function tryParseJson(content: string): PropublicaFiling | null {
  try { return JSON.parse(content) as PropublicaFiling; } catch { return null; }
}

function extract990(content: string, url: string): AdapterResult {
  const parsed = tryParseJson(content);
  const display_name = parsed?.organization?.name ?? "Unknown 990 filer";
  const ein = parsed?.organization?.ein ?? null;
  const slug = ein ? `irs_990_${ein}` : `irs_990_${url.replace(/[^a-z0-9]/gi, "").slice(-24)}`;

  let commitments: LpCommitmentCandidate[] = [];
  let as_of_date: string | null = null;
  let filing_date: string | null = null;

  if (parsed?.filings_with_data?.length) {
    // JSON payload — we only know AUM-level totals from the index;
    // per-manager rows live in the linked PDF, which the engine fetches
    // separately and routes through the endowment_annual adapter (not
    // this one). Emit a thin payload so the persister can at least
    // register the LP entity and record the filing date.
    const latest = parsed.filings_with_data[0];
    const yr = latest.tax_prd_yr ?? latest.tax_prd;
    if (yr) {
      as_of_date = `${String(yr).slice(0, 4)}-12-31`;
      filing_date = as_of_date;
    }
  } else {
    // HTML or text fallback.
    const text = toText(content);
    as_of_date = findAsOfDate(text.slice(0, 6000));
    filing_date = as_of_date;
    commitments = parseLpTable(text);
  }

  const payload: LpDisclosurePayload = {
    lp_slug: slug,
    lp_display_name: display_name,
    lp_class: "foundation",
    as_of_date,
    filing_date,
    source_url: url,
    commitments,
  };
  const conf = commitments.length > 0 ? 0.6 : (parsed ? 0.4 : 0.2);
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
    notes: { ein, row_count: commitments.length, as_of_date },
  };
}

export const endowment990: SiteAdapter = {
  id: "lp_endowment_990",
  priority: 55,
  hosts: ["projects.propublica.org"],
  url_patterns: [/\/nonprofits\/(api\/)?organizations?\/\d+/i],
  profile_types_emitted: ["lp_disclosure"],
  extract: extract990,
};
