// Task #2: CalPERS adapter — Quarterly PE Program Fund Performance Review.
//
// Source: https://www.calpers.ca.gov/about/investments/asset-classes/private-equity/pe-program-fund-performance
// The disclosure is a PDF; the engine's PDF tier converts to text upstream
// before this adapter runs. Format (post-text-extraction):
//
//   CalPERS Private Equity Program Fund Performance Review
//   as of <date>
//   $ in thousands
//
//   Fund Name                       Vintage  Commitment  Cash In  Cash Out  Reported Value  Net IRR
//   ACME Buyout Fund I, L.P.        2014     250,000     220,500  310,420   180,000          14.2%
//   ...
//
// Adapter is pure: it sniffs the as-of date + unit hint, runs the
// shared parser, and emits one LpDisclosurePayload candidate.

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

export const CALPERS_SLUG = "calpers";

function extractCalpers(content: string, url: string): AdapterResult {
  const text = toText(content);
  const as_of_date = findAsOfDate(text.slice(0, 4000));
  const commitments = parseLpTable(text);
  const payload: LpDisclosurePayload = {
    lp_slug: CALPERS_SLUG,
    lp_display_name: "California Public Employees' Retirement System",
    lp_class: "pension",
    as_of_date,
    filing_date: as_of_date,
    source_url: url,
    commitments,
  };
  const conf = commitments.length > 50 ? 0.95
             : commitments.length > 10 ? 0.8
             : commitments.length > 0  ? 0.5
             : 0.1;
  return {
    adapter_id: "lp_calpers",
    confidence: conf,
    candidates: [{
      profile_type: "lp_disclosure",
      confidence: conf,
      name: payload.lp_display_name,
      url,
      data: payload as unknown as Record<string, unknown>,
    }],
    child_urls: [],
    notes: { row_count: commitments.length, as_of_date },
  };
}

export const calpers: SiteAdapter = {
  id: "lp_calpers",
  priority: 70,
  hosts: ["www.calpers.ca.gov", "calpers.ca.gov"],
  url_patterns: [
    /\/private-equity\//i,
    /pe[-_]program[-_]fund[-_]performance/i,
    /aim-program-fund-performance/i,
  ],
  profile_types_emitted: ["lp_disclosure"],
  extract: extractCalpers,
};
