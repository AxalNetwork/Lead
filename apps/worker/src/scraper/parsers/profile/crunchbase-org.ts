// Crunchbase organization parser. Returns a FirmCandidate matching the
// `firms` schema (Task #15) so the dispatcher can hand it directly to the
// `upsertFirm` helper rather than the leads pipeline.

import type { FirmCandidate } from "../firmlists/types";

const NEXT_DATA_RE = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

interface OrgNode {
  identifier?: { value?: string; permalink?: string };
  legal_name?: string;
  short_description?: string;
  description?: string;
  website?: { value?: string };
  homepage_url?: { value?: string };
  founded_on?: { value?: string };
  num_employees_enum?: string;
  location_identifiers?: Array<{ value?: string; location_type?: string }>;
  category_groups?: Array<{ value?: string }>;
  categories?: Array<{ value?: string }>;
  funding_stage?: string;
  twitter?: { value?: string };
  linkedin?: { value?: string };
  facebook?: { value?: string };
  contact_email?: string;
}

function digForOrg(obj: unknown, depth = 0): OrgNode | null {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  const o = obj as Record<string, unknown>;
  if (o.identifier && (o.short_description || o.website || o.homepage_url || o.category_groups)) {
    return o as unknown as OrgNode;
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = digForOrg(item, depth + 1);
        if (hit) return hit;
      }
    } else if (v && typeof v === "object") {
      const hit = digForOrg(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function parseFoundedYear(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(\d{4})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1800 && y <= 2100 ? y : null;
}

function pickHq(node: OrgNode): { city: string | null; region: string | null; country: string | null } {
  const ids = node.location_identifiers || [];
  let city: string | null = null;
  let region: string | null = null;
  let country: string | null = null;
  for (const l of ids) {
    if (l.location_type === "city" && !city) city = l.value ?? null;
    else if (l.location_type === "region" && !region) region = l.value ?? null;
    else if (l.location_type === "country" && !country) country = l.value ?? null;
  }
  // Fallback: when types aren't tagged, take values positionally.
  if (!city && ids[0]?.value) city = ids[0].value;
  if (!region && ids[1]?.value) region = ids[1].value;
  if (!country && ids[2]?.value) country = ids[2].value;
  return { city, region, country };
}

function deriveDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isCrunchbaseOrgUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)crunchbase\.com$/i.test(u.hostname) && /^\/organization\/[^/]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseCrunchbaseOrg(html: string, url: string): FirmCandidate | null {
  const m = NEXT_DATA_RE.exec(html);
  if (!m) return null;
  let json: unknown;
  try { json = JSON.parse(m[1]); } catch { return null; }
  const node = digForOrg(json);
  if (!node) return null;

  const name = node.identifier?.value || null;
  if (!name) return null;
  const website = node.website?.value || node.homepage_url?.value || null;
  const hq = pickHq(node);
  const sectors = (node.category_groups || node.categories || []).map((c) => c?.value).filter((s): s is string => !!s);

  const candidate: FirmCandidate = {
    name,
    legal_name: node.legal_name ?? null,
    website,
    domain: deriveDomain(website),
    thesis: node.short_description || node.description || null,
    founded_year: parseFoundedYear(node.founded_on?.value),
    hq_city: hq.city,
    hq_region: hq.region,
    hq_country_iso2: null, // Crunchbase returns names, not ISO codes — let downstream geo-tag fill.
    sectors: sectors.length ? sectors : null,
    crunchbase_url: url,
    twitter_handle: node.twitter?.value || null,
    linkedin_url: node.linkedin?.value || null,
    contact_email: node.contact_email || null,
    source_url: url,
  };
  // hq_country_iso2 is the column on firms; we leave the country name in
  // `notes` so it isn't lost.
  if (hq.country) candidate.notes = `hq_country_name=${hq.country}`;

  return candidate;
}
