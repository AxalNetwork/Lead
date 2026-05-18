// Task #2: US public-pension LP adapters (config-driven).
//
// Each adapter shares the same pipeline (sniff date → parseLpTable →
// emit LpDisclosurePayload); the per-LP file differs only in its
// hosts[], url_patterns[], slug, and display name. New LPs are added
// by appending an entry to PENSION_CONFIGS.

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

interface PensionConfig {
  id: string;
  slug: string;
  display_name: string;
  hosts: string[];
  url_patterns: RegExp[];
  /** Optional explicit unit multiplier override. */
  unit_multiplier?: number;
}

export const PENSION_CONFIGS: PensionConfig[] = [
  // CalPERS is its own file (calpers.ts) — canonical reference.
  { id: "lp_calstrs", slug: "calstrs", display_name: "California State Teachers' Retirement System",
    hosts: ["www.calstrs.com", "calstrs.com"],
    url_patterns: [/\/private-equity/i, /pe-portfolio-performance/i] },
  { id: "lp_ohio_pers", slug: "ohio_pers", display_name: "Ohio Public Employees Retirement System",
    hosts: ["www.opers.org", "opers.org"],
    url_patterns: [/private-equity|alternative-investments/i] },
  { id: "lp_nyscrf", slug: "nyscrf", display_name: "New York State Common Retirement Fund",
    hosts: ["www.osc.state.ny.us", "osc.state.ny.us", "www.osc.ny.gov", "osc.ny.gov"],
    url_patterns: [/common-retirement-fund.*private-equity/i, /pension-investments\/private-equity/i] },
  { id: "lp_oregon_perf", slug: "oregon_perf", display_name: "Oregon Public Employees Retirement Fund",
    hosts: ["www.oregon.gov", "oregon.gov"],
    url_patterns: [/treasury.*private-equity/i, /opers.*investments/i] },
  { id: "lp_wa_sib", slug: "wa_sib", display_name: "Washington State Investment Board",
    hosts: ["www.sib.wa.gov", "sib.wa.gov"],
    url_patterns: [/private-equity|alternative-assets/i] },
  { id: "lp_texas_trs", slug: "texas_trs", display_name: "Teacher Retirement System of Texas",
    hosts: ["www.trs.texas.gov", "trs.texas.gov"],
    url_patterns: [/investments?.*private-equity/i, /private[-_]equity/i] },
  { id: "lp_wsib", slug: "wsib", display_name: "Wisconsin State Investment Board",
    hosts: ["www.swib.state.wi.us", "swib.state.wi.us"],
    url_patterns: [/private-markets|alternative-investments/i] },
  { id: "lp_michigan_bureau", slug: "michigan_bureau", display_name: "Michigan Bureau of Investments",
    hosts: ["www.michigan.gov", "michigan.gov"],
    url_patterns: [/treasury.*bureau-of-investments/i, /investments.*alternative/i] },
  { id: "lp_maine_pers", slug: "maine_pers", display_name: "Maine Public Employees Retirement System",
    hosts: ["www.mainepers.org", "mainepers.org"],
    url_patterns: [/investments|alternative-assets/i] },
  { id: "lp_alaska_prm", slug: "alaska_prm", display_name: "Alaska Permanent Fund Corporation",
    hosts: ["www.apfc.org", "apfc.org"],
    url_patterns: [/investments|private-equity/i] },
  { id: "lp_virginia_vrs", slug: "virginia_vrs", display_name: "Virginia Retirement System",
    hosts: ["www.varetire.org", "varetire.org"],
    url_patterns: [/investments|private-equity|private-investment/i] },
  { id: "lp_mass_prim", slug: "mass_prim", display_name: "Massachusetts Pension Reserves Investment Management",
    hosts: ["www.mapension.com", "mapension.com", "www.mass.gov", "mass.gov"],
    url_patterns: [/prim|private-equity/i] },
  { id: "lp_nj_division", slug: "nj_division", display_name: "New Jersey Division of Investment",
    hosts: ["www.nj.gov", "nj.gov"],
    url_patterns: [/treasury.*doinvest|private-equity/i] },
  { id: "lp_florida_sba", slug: "florida_sba", display_name: "Florida State Board of Administration",
    hosts: ["www.sbafla.com", "sbafla.com"],
    url_patterns: [/private-equity|strategic-investments/i] },
  { id: "lp_illinois_mrf", slug: "illinois_mrf", display_name: "Illinois Municipal Retirement Fund",
    hosts: ["www.imrf.org", "imrf.org"],
    url_patterns: [/investments?|private-equity/i] },
  { id: "lp_penn_psers", slug: "penn_psers", display_name: "Pennsylvania Public School Employees' Retirement System",
    hosts: ["www.psers.pa.gov", "psers.pa.gov"],
    url_patterns: [/investments|private-markets/i] },
  { id: "lp_ncrs", slug: "ncrs", display_name: "North Carolina Retirement Systems",
    hosts: ["www.nctreasurer.com", "nctreasurer.com"],
    url_patterns: [/investments|private-equity/i] },
  { id: "lp_sc_rsic", slug: "sc_rsic", display_name: "South Carolina Retirement System Investment Commission",
    hosts: ["www.rsic.sc.gov", "rsic.sc.gov"],
    url_patterns: [/private-equity|investments/i] },
  { id: "lp_wisconsin_investment", slug: "wisconsin_investment", display_name: "State of Wisconsin Investment Board (SWIB)",
    hosts: ["www.swib.state.wi.us"],
    url_patterns: [/private-markets/i] },
];

function makeExtractor(cfg: PensionConfig) {
  return function extractPension(content: string, url: string): AdapterResult {
    const text = toText(content);
    const as_of_date = findAsOfDate(text.slice(0, 4000));
    const commitments = parseLpTable(text, { unit_multiplier: cfg.unit_multiplier });
    const payload: LpDisclosurePayload = {
      lp_slug: cfg.slug,
      lp_display_name: cfg.display_name,
      lp_class: "pension",
      as_of_date,
      filing_date: as_of_date,
      source_url: url,
      commitments,
    };
    const conf = commitments.length > 50 ? 0.9
               : commitments.length > 10 ? 0.75
               : commitments.length > 0  ? 0.45
               : 0.1;
    return {
      adapter_id: cfg.id,
      confidence: conf,
      candidates: [{
        profile_type: "lp_disclosure",
        confidence: conf,
        name: cfg.display_name,
        url,
        data: payload as unknown as Record<string, unknown>,
      }],
      child_urls: [],
      notes: { row_count: commitments.length, as_of_date, lp_slug: cfg.slug },
    };
  };
}

export const US_PENSION_ADAPTERS: SiteAdapter[] = PENSION_CONFIGS.map((cfg) => ({
  id: cfg.id,
  priority: 65,
  hosts: cfg.hosts,
  url_patterns: cfg.url_patterns,
  profile_types_emitted: ["lp_disclosure"],
  extract: makeExtractor(cfg),
}));
