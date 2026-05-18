// Task #2: University endowment / foundation annual-report adapter.
//
// Endowment annual reports typically list private-investment managers
// (anonymized as "Manager A/B/…" or named in less-redacted reports)
// with each manager's allocation. We pass the table through the same
// shared parser; even anonymized rows are persisted as commitment
// candidates (the LP-mix donut counts dollars, not names).

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload, LpClass } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

interface EndowmentConfig {
  id: string;
  slug: string;
  display_name: string;
  hosts: string[];
  url_patterns: RegExp[];
  lp_class: LpClass;
}

export const ENDOWMENT_CONFIGS: EndowmentConfig[] = [
  { id: "lp_harvard",    slug: "harvard_endowment",    display_name: "Harvard Management Company",
    hosts: ["www.hmc.harvard.edu", "hmc.harvard.edu"], url_patterns: [/annual-report|financial-report/i], lp_class: "endowment" },
  { id: "lp_yale",       slug: "yale_endowment",       display_name: "Yale Investments Office",
    hosts: ["investments.yale.edu"], url_patterns: [/annual-report|endowment-update/i], lp_class: "endowment" },
  { id: "lp_stanford",   slug: "stanford_endowment",   display_name: "Stanford Management Company",
    hosts: ["smc.stanford.edu"], url_patterns: [/annual-report|investment-report/i], lp_class: "endowment" },
  { id: "lp_princeton",  slug: "princeton_endowment",  display_name: "Princeton University Investment Company",
    hosts: ["princo.princeton.edu", "www.princeton.edu"], url_patterns: [/princo|endowment|annual-report/i], lp_class: "endowment" },
  { id: "lp_mit",        slug: "mit_endowment",        display_name: "MIT Investment Management Company",
    hosts: ["mitimco.org", "www.mitimco.org"], url_patterns: [/annual-report|endowment/i], lp_class: "endowment" },
  { id: "lp_penn",       slug: "penn_endowment",       display_name: "University of Pennsylvania Office of Investments",
    hosts: ["www.upenn.edu"], url_patterns: [/oinvest|endowment|investment-report/i], lp_class: "endowment" },
  { id: "lp_columbia",   slug: "columbia_endowment",   display_name: "Columbia Investment Management Company",
    hosts: ["www.cimc.columbia.edu", "cimc.columbia.edu"], url_patterns: [/annual-report|endowment/i], lp_class: "endowment" },
  { id: "lp_cornell",    slug: "cornell_endowment",    display_name: "Cornell University Office of University Investments",
    hosts: ["dfa.cornell.edu", "www.dfa.cornell.edu"], url_patterns: [/investments|endowment-report/i], lp_class: "endowment" },
  { id: "lp_dartmouth",  slug: "dartmouth_endowment",  display_name: "Dartmouth College Investment Office",
    hosts: ["www.dartmouth.edu"], url_patterns: [/investment-office|endowment/i], lp_class: "endowment" },
  { id: "lp_brown",      slug: "brown_endowment",      display_name: "Brown University Investment Office",
    hosts: ["www.brown.edu"], url_patterns: [/investment-office|endowment/i], lp_class: "endowment" },
  { id: "lp_jhu",        slug: "jhu_endowment",        display_name: "Johns Hopkins University Investment Office",
    hosts: ["finance.jhu.edu", "www.jhu.edu"], url_patterns: [/investment|endowment/i], lp_class: "endowment" },
  { id: "lp_northwestern", slug: "northwestern_endowment", display_name: "Northwestern University Investment Office",
    hosts: ["www.northwestern.edu"], url_patterns: [/investment-office|endowment/i], lp_class: "endowment" },
  { id: "lp_duke",       slug: "duke_endowment",       display_name: "DUMAC (Duke University Management Company)",
    hosts: ["www.dumac.duke.edu", "dumac.duke.edu"], url_patterns: [/annual-report|investment/i], lp_class: "endowment" },
  { id: "lp_notre_dame", slug: "notre_dame_endowment", display_name: "University of Notre Dame Investment Office",
    hosts: ["investment.nd.edu", "www.nd.edu"], url_patterns: [/investment|endowment/i], lp_class: "endowment" },
  { id: "lp_usc",        slug: "usc_endowment",        display_name: "USC Office of Investment Management",
    hosts: ["www.usc.edu"], url_patterns: [/investment-office|endowment/i], lp_class: "endowment" },
  { id: "lp_ucla_foundation", slug: "ucla_foundation", display_name: "UCLA Foundation",
    hosts: ["www.uclafoundation.org", "uclafoundation.org"], url_patterns: [/financial|annual-report/i], lp_class: "foundation" },
  { id: "lp_cambridge",  slug: "cambridge_endowment",  display_name: "Cambridge University Endowment Fund",
    hosts: ["www.endowment.cam.ac.uk", "endowment.cam.ac.uk"], url_patterns: [/annual-report|investment/i], lp_class: "endowment" },
  { id: "lp_oxford",     slug: "oxford_endowment",     display_name: "Oxford University Endowment Management",
    hosts: ["www.ouem.co.uk", "ouem.co.uk"], url_patterns: [/annual-report|investment/i], lp_class: "endowment" },
];

function makeExtractor(cfg: EndowmentConfig) {
  return function extractEndowment(content: string, url: string): AdapterResult {
    const text = toText(content);
    const as_of_date = findAsOfDate(text.slice(0, 6000));
    const commitments = parseLpTable(text);
    const payload: LpDisclosurePayload = {
      lp_slug: cfg.slug,
      lp_display_name: cfg.display_name,
      lp_class: cfg.lp_class,
      as_of_date,
      filing_date: as_of_date,
      source_url: url,
      commitments,
    };
    const conf = commitments.length > 20 ? 0.85
               : commitments.length > 5  ? 0.6
               : commitments.length > 0  ? 0.4
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

export const ENDOWMENT_ANNUAL_ADAPTERS: SiteAdapter[] = ENDOWMENT_CONFIGS.map((cfg) => ({
  id: cfg.id,
  priority: 60,
  hosts: cfg.hosts,
  url_patterns: cfg.url_patterns,
  profile_types_emitted: ["lp_disclosure"],
  extract: makeExtractor(cfg),
}));
