// UK Companies House public records adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const companiesHouseUK: SiteAdapter = {
  id: "companies_house_uk",
  priority: 80,
  hosts: ["find-and-update.company-information.service.gov.uk", "beta.companieshouse.gov.uk"],
  url_patterns: [/^\/company\/[A-Z0-9]+/i, /^\/officers\/[A-Za-z0-9_-]+/i],
  profile_types_emitted: ["founder", "board_member"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html);
    const text = stripTags(html);
    const name = title.replace(/\s*-\s*GOV\.UK.*$/i, "").trim() || null;
    const companyNo = text.match(/Company number\s+([A-Z0-9]+)/i)?.[1] ?? url.match(/\/company\/([A-Z0-9]+)/i)?.[1] ?? null;
    const incorporated = text.match(/Incorporated on\s+(\d{1,2}\s+\w+\s+\d{4})/i)?.[1] ?? null;
    const status = text.match(/Company status\s+([A-Za-z ]+?)(?:\s+Company)/i)?.[1]?.trim() ?? null;
    const sicCodes = [...text.matchAll(/\b(\d{4,5})\s*-\s*([A-Za-z][A-Za-z ,.&'-]+)/g)].slice(0, 8).map((m) => ({ code: m[1], description: m[2].trim() }));
    return {
      adapter_id: "companies_house_uk",
      confidence: companyNo ? 0.75 : (name ? 0.4 : 0.2),
      candidates: [{
        profile_type: null,
        confidence: companyNo ? 0.75 : 0.4,
        name, url,
        data: { company_name: name, company_number: companyNo, incorporated, status, sic_codes: sicCodes, ch_url: url },
      }],
      child_urls: [],
    };
  },
};
