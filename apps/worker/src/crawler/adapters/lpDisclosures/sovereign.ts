// Task #2: Sovereign wealth fund annual-report adapters.
//
// Sovereigns publish annual reports with private-equity / direct
// investment tables. Format varies but rows follow the same shape
// (fund/manager, vintage/year, commitment, NAV, IRR), so the shared
// parser applies.

import type { SiteAdapter, AdapterResult } from "../types";
import type { LpDisclosurePayload } from "./types";
import { toText, findAsOfDate, parseLpTable } from "./_shared";

interface SovereignConfig {
  id: string;
  slug: string;
  display_name: string;
  hosts: string[];
  url_patterns: RegExp[];
}

export const SOVEREIGN_CONFIGS: SovereignConfig[] = [
  { id: "lp_temasek",   slug: "temasek",   display_name: "Temasek Holdings",
    hosts: ["www.temasekreview.com.sg", "www.temasek.com.sg", "temasek.com.sg"],
    url_patterns: [/review|annual-report/i] },
  { id: "lp_gic",       slug: "gic",       display_name: "GIC Private Limited",
    hosts: ["www.gic.com.sg", "gic.com.sg"],
    url_patterns: [/report|annual-report/i] },
  { id: "lp_nbim",      slug: "nbim",      display_name: "Norges Bank Investment Management",
    hosts: ["www.nbim.no", "nbim.no"],
    url_patterns: [/annual-report|holdings/i] },
  { id: "lp_mubadala",  slug: "mubadala",  display_name: "Mubadala Investment Company",
    hosts: ["www.mubadala.com", "mubadala.com"],
    url_patterns: [/annual-report|review/i] },
  { id: "lp_adia",      slug: "adia",      display_name: "Abu Dhabi Investment Authority",
    hosts: ["www.adia.ae", "adia.ae"],
    url_patterns: [/annual-review|annual-report/i] },
  { id: "lp_pif",       slug: "pif",       display_name: "Public Investment Fund (Saudi Arabia)",
    hosts: ["www.pif.gov.sa", "pif.gov.sa"],
    url_patterns: [/annual-report|disclosures/i] },
  { id: "lp_cic",       slug: "cic",       display_name: "China Investment Corporation",
    hosts: ["www.china-inv.cn", "china-inv.cn"],
    url_patterns: [/annual-report|english/i] },
  { id: "lp_kia",       slug: "kia",       display_name: "Kuwait Investment Authority",
    hosts: ["www.kia.gov.kw", "kia.gov.kw"],
    url_patterns: [/annual-report|en/i] },
  { id: "lp_nz_super",  slug: "nz_super",  display_name: "New Zealand Superannuation Fund",
    hosts: ["www.nzsuperfund.nz", "nzsuperfund.nz"],
    url_patterns: [/annual-report|investments/i] },
  { id: "lp_ausfuture", slug: "ausfuture", display_name: "Future Fund (Australia)",
    hosts: ["www.futurefund.gov.au", "futurefund.gov.au"],
    url_patterns: [/annual-report|investments/i] },
  { id: "lp_omers",     slug: "omers",     display_name: "OMERS",
    hosts: ["www.omers.com", "omers.com"],
    url_patterns: [/annual-report|results/i] },
  { id: "lp_cpp",       slug: "cpp",       display_name: "CPP Investments",
    hosts: ["www.cppinvestments.com", "cppinvestments.com"],
    url_patterns: [/annual-report|results/i] },
  { id: "lp_otpp",      slug: "otpp",      display_name: "Ontario Teachers' Pension Plan",
    hosts: ["www.otpp.com", "otpp.com"],
    url_patterns: [/annual-report|results/i] },
  { id: "lp_cdpq",      slug: "cdpq",      display_name: "Caisse de dépôt et placement du Québec",
    hosts: ["www.cdpq.com", "cdpq.com"],
    url_patterns: [/annual-report|results/i] },
];

function makeExtractor(cfg: SovereignConfig) {
  return function extractSovereign(content: string, url: string): AdapterResult {
    const text = toText(content);
    const as_of_date = findAsOfDate(text.slice(0, 6000));
    const commitments = parseLpTable(text);
    const payload: LpDisclosurePayload = {
      lp_slug: cfg.slug,
      lp_display_name: cfg.display_name,
      lp_class: "sovereign",
      as_of_date,
      filing_date: as_of_date,
      source_url: url,
      commitments,
    };
    const conf = commitments.length > 20 ? 0.85
               : commitments.length > 5  ? 0.6
               : commitments.length > 0  ? 0.4
               : 0.15;
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

export const SOVEREIGN_ADAPTERS: SiteAdapter[] = SOVEREIGN_CONFIGS.map((cfg) => ({
  id: cfg.id,
  priority: 60,
  hosts: cfg.hosts,
  url_patterns: cfg.url_patterns,
  profile_types_emitted: ["lp_disclosure"],
  extract: makeExtractor(cfg),
}));
