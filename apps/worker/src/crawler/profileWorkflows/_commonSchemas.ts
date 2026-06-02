// Task #1: JSON schemas + mappers reused across typed workflows.
//
// Every per-type module declares its own `WorkflowDef`, but most of the
// schema surface is the same across firm-shaped (investor_vc / pe /
// accelerator / family_office) and person-shaped (founder / investor_person
// / lawyer / banker / academic / journalist / politician) workflows.
// Centralizing the schemas keeps the predicate vocabulary consistent and
// gives the cross-source verifier a single normalized shape to bucket on.

import type { FactCandidate, PlannedSource, WorkflowContext } from "./_types";
import { cleanEmail } from "./identityHarvest";

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
    email:              { type: "string" },
    linkedin_url:       { type: "string" },
    twitter_url:        { type: "string" },
    github_url:         { type: "string" },
    personal_url:       { type: "string" },
    confidence:         { type: "number" },
  },
  required: ["confidence"],
} as const;

export interface PersonExtract {
  email?: string;
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
  // Email is written as the canonical BARE `email` predicate (category
  // contact in the predicate registry) rather than role-prefixed, so the
  // dossier + UI surface it uniformly across every person type. Role
  // inboxes / placeholders are dropped by cleanEmail.
  if (typeof j.email === "string") {
    const e = cleanEmail(j.email);
    if (e) out.push({ predicate: "email", valueText: e, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
  }
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

// ---- Concrete public-source builders ------------------------------------
//
// Each helper derives a deterministic public-endpoint URL from the
// candidate's displayName / host slug. These are the *direct* sources
// the task spec calls for (Wikipedia entity, SEC EDGAR adviser search,
// LinkedIn / Crunchbase / GitHub / Twitter public, congress.gov,
// FEC, Google Scholar HTML, arXiv, Semantic Scholar, Muck Rack,
// SEC.gov bios). Workflows compose these into their `plan` so the
// crossRef verifier sees genuinely distinct buckets — not three
// search-engine result pages that all paraphrase the same source.
//
// Slug derivation: prefer displayName; fall back to the candidate host
// minus its TLD. Normalization strips punctuation so the slugs match
// what Wikipedia / Crunchbase / LinkedIn use in URLs in the common case.

function pickSlugBase(ctx: WorkflowContext): string {
  const dn = (ctx.displayName ?? "").trim();
  if (dn) return dn;
  const host = (ctx.candidateHost ?? "").replace(/\.[a-z]{2,}$/i, "");
  return host;
}

/** Slug for URL path: lowercase, hyphenated, alphanumeric. */
export function urlSlug(ctx: WorkflowContext): string {
  return pickSlugBase(ctx)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug for Wikipedia: Title_Case_With_Underscores. */
export function wikiSlug(ctx: WorkflowContext): string {
  const base = pickSlugBase(ctx).replace(/\s+/g, " ").trim();
  return base.split(" ").filter(Boolean).map((w) => w.length ? w[0].toUpperCase() + w.slice(1) : "").join("_");
}

/** Public Wikipedia entity URL (best-effort). */
export function wikipediaUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "wikipedia", url: `https://en.wikipedia.org/wiki/${wikiSlug(ctx)}`, optional: true };
}

/** LinkedIn public company page. */
export function linkedinCompanyUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "linkedin_company", url: `https://www.linkedin.com/company/${urlSlug(ctx)}`, optional: true };
}

/** LinkedIn public person page. */
export function linkedinPersonUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "linkedin_in", url: `https://www.linkedin.com/in/${urlSlug(ctx)}`, optional: true };
}

/** Crunchbase organization page. */
export function crunchbaseOrgUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "crunchbase_org", url: `https://www.crunchbase.com/organization/${urlSlug(ctx)}`, optional: true };
}

/** Crunchbase person page. */
export function crunchbasePersonUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "crunchbase_person", url: `https://www.crunchbase.com/person/${urlSlug(ctx)}`, optional: true };
}

/** GitHub public user. */
export function githubUserUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const slug = urlSlug(ctx).replace(/-/g, "");
  return { tag: "github", url: `https://github.com/${slug}`, optional: true };
}

/** Twitter/X public profile. */
export function twitterUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const slug = urlSlug(ctx).replace(/-/g, "");
  return { tag: "twitter", url: `https://twitter.com/${slug}`, optional: true };
}

/** SEC EDGAR Investment Adviser Public Disclosure search by firm name. */
export function secEdgarAdvUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "sec_edgar_adv", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${q}&type=ADV&dateb=&owner=include&count=40`, optional: true };
}

/** SEC.gov bio search (regulators/commissioners). */
export function secGovBioUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "sec_gov_bio", url: `https://www.sec.gov/cgi-bin/srqsb?text=${q}`, optional: true };
}

/** congress.gov member search. */
export function congressGovUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "congress_gov", url: `https://www.congress.gov/members?q={"search":"${q}"}`, optional: true };
}

/** FEC committee search by candidate / committee name. */
export function fecUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "fec", url: `https://www.fec.gov/data/candidates/?q=${q}`, optional: true };
}

/** Google Scholar (HTML, no API) — author search. */
export function googleScholarUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "google_scholar", url: `https://scholar.google.com/scholar?q=author:%22${q}%22`, optional: true };
}

/** arXiv author search. */
export function arxivUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "arxiv", url: `https://arxiv.org/a/${q}`, optional: true };
}

/** Semantic Scholar author search. */
export function semanticScholarUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "semantic_scholar", url: `https://www.semanticscholar.org/search?q=${q}&sort=relevance`, optional: true };
}

/** Muck Rack public profile (journalists). */
export function muckRackUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  return { tag: "muckrack", url: `https://muckrack.com/${urlSlug(ctx)}`, optional: true };
}

/** FINRA BrokerCheck firm search (bankers). */
export function finraBrokerCheckUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "finra_brokercheck", url: `https://brokercheck.finra.org/search/genericsearch/grid?query=${q}`, optional: true };
}

/** Martindale-Hubbell attorney lookup. */
export function martindaleUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "martindale", url: `https://www.martindale.com/find-attorneys/?term=${q}`, optional: true };
}

/** CourtListener party search (securities attorneys). */
export function courtListenerUrl(ctx: WorkflowContext): { tag: string; url: string; optional: true } {
  const q = encodeURIComponent(pickSlugBase(ctx));
  return { tag: "courtlistener", url: `https://www.courtlistener.com/?q=${q}&type=r`, optional: true };
}
