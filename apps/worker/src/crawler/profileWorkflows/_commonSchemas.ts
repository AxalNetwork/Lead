// Task #1: JSON schemas + mappers reused across typed workflows.
//
// Every per-type module declares its own `WorkflowDef`, but most of the
// schema surface is the same across firm-shaped (investor_vc / pe /
// accelerator / family_office) and person-shaped (founder / investor_person
// / lawyer / banker / academic / journalist / politician) workflows.
// Centralizing the schemas keeps the predicate vocabulary consistent and
// gives the cross-source verifier a single normalized shape to bucket on.

import type { FactCandidate, PlannedSource, WorkflowContext } from "./_types";

// ---- Firm schema --------------------------------------------------------

export const FIRM_SCHEMA = {
  type: "object",
  properties: {
    display_name:           { type: "string" },
    one_liner:              { type: "string" },
    founded_year:           { type: "number" },
    hq_city:                { type: "string" },
    hq_country:             { type: "string" },
    aum_usd:                { type: "number" },
    stages:                 { type: "array", items: { type: "string" } },
    sectors:                { type: "array", items: { type: "string" } },
    geo_focus:              { type: "array", items: { type: "string" } },
    check_size_min_usd:     { type: "number" },
    check_size_max_usd:     { type: "number" },
    portfolio_count:        { type: "number" },
    current_fund_number:    { type: "number" },
    current_fund_size_usd:  { type: "number" },
    gp_names:               { type: "array", items: { type: "string" } },
    partner_names:          { type: "array", items: { type: "string" } },
    confidence:             { type: "number" },
  },
  required: ["confidence"],
} as const;

export interface FirmExtract {
  display_name?: string;
  one_liner?: string;
  founded_year?: number;
  hq_city?: string;
  hq_country?: string;
  aum_usd?: number;
  stages?: string[];
  sectors?: string[];
  geo_focus?: string[];
  check_size_min_usd?: number;
  check_size_max_usd?: number;
  portfolio_count?: number;
  current_fund_number?: number;
  current_fund_size_usd?: number;
  gp_names?: string[];
  partner_names?: string[];
  confidence?: number;
}

function strField(out: FactCandidate[], pred: string, v: unknown, src: PlannedSource, conf: number): void {
  if (typeof v === "string" && v.trim().length > 0) {
    out.push({ predicate: pred, valueText: v.trim(), sourceUrl: src.url, sourceTag: src.tag, confidence: conf });
  }
}
function numField(out: FactCandidate[], pred: string, v: unknown, src: PlannedSource, conf: number): void {
  if (typeof v === "number" && Number.isFinite(v)) {
    out.push({ predicate: pred, valueNumber: v, sourceUrl: src.url, sourceTag: src.tag, confidence: conf });
  }
}
function arrField(out: FactCandidate[], pred: string, v: unknown, src: PlannedSource, conf: number): void {
  if (Array.isArray(v) && v.length > 0) {
    const norm = v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim().toLowerCase());
    if (norm.length > 0) out.push({ predicate: pred, valueJson: norm, sourceUrl: src.url, sourceTag: src.tag, confidence: conf });
  }
}

export function mapFirm(j: FirmExtract, source: PlannedSource): FactCandidate[] {
  const out: FactCandidate[] = [];
  const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
  strField(out, "firm.display_name",     j.display_name,    source, conf);
  strField(out, "firm.one_liner",        j.one_liner,       source, conf);
  numField(out, "firm.founded_year",     j.founded_year,    source, conf);
  strField(out, "firm.hq_city",          j.hq_city,         source, conf);
  strField(out, "firm.hq_country",       j.hq_country,      source, conf);
  numField(out, "firm.aum_usd",          j.aum_usd,         source, conf);
  arrField(out, "firm.stages",           j.stages,          source, conf);
  arrField(out, "firm.sectors",          j.sectors,         source, conf);
  arrField(out, "firm.geo_focus",        j.geo_focus,       source, conf);
  numField(out, "firm.check_size_min_usd", j.check_size_min_usd, source, conf);
  numField(out, "firm.check_size_max_usd", j.check_size_max_usd, source, conf);
  numField(out, "firm.portfolio_count",  j.portfolio_count, source, conf);
  numField(out, "firm.current_fund_number",   j.current_fund_number,   source, conf);
  numField(out, "firm.current_fund_size_usd", j.current_fund_size_usd, source, conf);
  arrField(out, "firm.gp_names",         j.gp_names,        source, conf);
  arrField(out, "firm.partner_names",    j.partner_names,   source, conf);
  return out;
}

// ---- Person schema ------------------------------------------------------

export const PERSON_SCHEMA = {
  type: "object",
  properties: {
    full_name:          { type: "string" },
    current_title:      { type: "string" },
    current_employer:   { type: "string" },
    prior_employers:    { type: "array", items: { type: "string" } },
    education:          { type: "array", items: { type: "string" } },
    notable_works:      { type: "array", items: { type: "string" } },
    focus_areas:        { type: "array", items: { type: "string" } },
    location_city:      { type: "string" },
    location_country:   { type: "string" },
    linkedin_url:       { type: "string" },
    twitter_url:        { type: "string" },
    github_url:         { type: "string" },
    personal_url:       { type: "string" },
    confidence:         { type: "number" },
  },
  required: ["confidence"],
} as const;

export interface PersonExtract {
  full_name?: string;
  current_title?: string;
  current_employer?: string;
  prior_employers?: string[];
  education?: string[];
  notable_works?: string[];
  focus_areas?: string[];
  location_city?: string;
  location_country?: string;
  linkedin_url?: string;
  twitter_url?: string;
  github_url?: string;
  personal_url?: string;
  confidence?: number;
}

export function mapPerson(j: PersonExtract, source: PlannedSource, predicatePrefix = "person"): FactCandidate[] {
  const out: FactCandidate[] = [];
  const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
  strField(out, `${predicatePrefix}.full_name`,        j.full_name,        source, conf);
  strField(out, `${predicatePrefix}.current_title`,    j.current_title,    source, conf);
  strField(out, `${predicatePrefix}.current_employer`, j.current_employer, source, conf);
  arrField(out, `${predicatePrefix}.prior_employers`,  j.prior_employers,  source, conf);
  arrField(out, `${predicatePrefix}.education`,        j.education,        source, conf);
  arrField(out, `${predicatePrefix}.notable_works`,    j.notable_works,    source, conf);
  arrField(out, `${predicatePrefix}.focus_areas`,      j.focus_areas,      source, conf);
  strField(out, `${predicatePrefix}.location_city`,    j.location_city,    source, conf);
  strField(out, `${predicatePrefix}.location_country`, j.location_country, source, conf);
  strField(out, `${predicatePrefix}.linkedin_url`,     j.linkedin_url,     source, conf);
  strField(out, `${predicatePrefix}.twitter_url`,      j.twitter_url,      source, conf);
  strField(out, `${predicatePrefix}.github_url`,       j.github_url,       source, conf);
  strField(out, `${predicatePrefix}.personal_url`,     j.personal_url,     source, conf);
  return out;
}

// ---- Web-search bootstrap (fallback / generic types) -------------------

/** Build "name + qualifier" search URLs against three privacy-respecting
 *  endpoints. The fetcher walks each result page; the AI step picks
 *  links. We deliberately avoid commercial search APIs (task contract). */
export function searchUrls(query: string): { tag: string; url: string }[] {
  const q = encodeURIComponent(query);
  return [
    { tag: "search:duckduckgo", url: `https://duckduckgo.com/html/?q=${q}` },
    { tag: "search:mojeek",     url: `https://www.mojeek.com/search?q=${q}` },
    { tag: "search:wikipedia",  url: `https://en.wikipedia.org/wiki/Special:Search?search=${q}` },
  ];
}

/** Helper for type-specific modules: pull a heuristic search query out of
 *  the display name + extra qualifier. */
export function namedQuery(ctx: WorkflowContext, qualifier: string): string {
  const base = ctx.displayName ?? ctx.candidateHost;
  return `${base} ${qualifier}`.trim();
}
