// Public law-firm / attorney directory adapter — Martindale, Avvo,
// state-bar lookups.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

export const lawFirmDirectories: SiteAdapter = {
  id: "law_firm_directories",
  priority: 70,
  hosts: [
    "martindale.com", "www.martindale.com",
    "avvo.com", "www.avvo.com",
    "lawyers.findlaw.com", "www.lawyers.findlaw.com",
  ],
  url_patterns: [/^\/attorney\//i, /^\/law-firm\//i, /^\/lawyers\//i, /^\/profile\//i],
  profile_types_emitted: ["lawyer", "law_firm"],
  extract(html, url): AdapterResult {
    const title = pickMeta(html, "og:title") || pickTitle(html);
    const text = stripTags(html);
    const name = title.replace(/\s*\|.*$/, "").replace(/\s*-\s*(?:Martindale|Avvo|FindLaw).*$/i, "").trim() || null;
    const firm = text.match(/(?:Firm|Law Firm)[:\s]+([A-Z][A-Za-z0-9 ,.&'-]+(?:LLP|LLC|PLLC|P\.C\.))/i)?.[1]?.trim() ?? null;
    const barState = text.match(/Bar\s+(?:Admitted|Admission)[:\s]+([A-Z][A-Za-z ]+)/i)?.[1]?.trim()
      ?? text.match(/Licensed in\s+([A-Z][A-Za-z ]+)/i)?.[1]?.trim() ?? null;
    const jdSchool = text.match(/(?:J\.D\.|JD,)\s+(?:from\s+)?([A-Z][A-Za-z. ]+(?:Law School|University|College|Law))/i)?.[1]?.trim() ?? null;
    const practiceAreas = (text.match(/Practice Areas?[:\s]+([A-Z][A-Za-z, ]+)/i)?.[1]?.split(/,\s*/) ?? []).slice(0, 8);
    return {
      adapter_id: "law_firm_directories",
      confidence: name ? 0.65 : 0.25,
      candidates: [{
        profile_type: "lawyer",
        confidence: name ? 0.65 : 0.25,
        name, url,
        data: { name, law_firm_employer: firm, bar_state: barState, jd_school: jdSchool, practice_areas: practiceAreas, profile_url: url },
      }],
      child_urls: [],
    };
  },
};
