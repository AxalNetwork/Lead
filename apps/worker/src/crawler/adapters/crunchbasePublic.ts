// Crunchbase public organization / person page adapter. Parses the
// embedded __NEXT_DATA__ JSON island that ships with every Crunchbase
// page render.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { parseNextData, digFor, pickMeta, pickTitle } from "./_util";

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
  funding_stage?: string;
  twitter?: { value?: string };
  linkedin?: { value?: string };
  contact_email?: string;
  funding_total?: { value_usd?: number };
  num_funding_rounds?: number;
}

interface PersonNode {
  identifier?: { value?: string; permalink?: string };
  first_name?: string;
  last_name?: string;
  short_description?: string;
  description?: string;
  primary_job_title?: string;
  primary_organization?: { value?: string };
  linkedin?: { value?: string };
  twitter?: { value?: string };
}

function digOrg(json: unknown): OrgNode | null {
  return digFor<OrgNode>(json, (o) =>
    !!o.identifier && (!!o.short_description || !!o.website || !!o.homepage_url || !!o.category_groups));
}

function digPerson(json: unknown): PersonNode | null {
  return digFor<PersonNode>(json, (o) => !!o.identifier && (!!o.first_name || !!o.last_name) && !!o.primary_job_title);
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
  let city: string | null = null, region: string | null = null, country: string | null = null;
  for (const l of ids) {
    if (l.location_type === "city" && !city) city = l.value ?? null;
    else if (l.location_type === "region" && !region) region = l.value ?? null;
    else if (l.location_type === "country" && !country) country = l.value ?? null;
  }
  return { city, region, country };
}

export const crunchbasePublic: SiteAdapter = {
  id: "crunchbase_public",
  priority: 85,
  hosts: ["crunchbase.com", "www.crunchbase.com"],
  url_patterns: [/^\/organization\/[^/]+/i, /^\/person\/[^/]+/i, /^\/funding_round\/[^/]+/i],
  profile_types_emitted: ["firm_person", "investor_vc", "investor_pe", "portfolio_company"],
  extract(html, url): AdapterResult {
    const candidates: AdapterCandidate[] = [];
    const child: string[] = [];
    const data = parseNextData(html);
    if (/\/organization\//i.test(url)) {
      const node = data ? digOrg(data) : null;
      if (node) {
        const name = node.identifier?.value || pickMeta(html, "og:title") || pickTitle(html);
        const website = node.website?.value || node.homepage_url?.value || null;
        const hq = pickHq(node);
        candidates.push({
          profile_type: null, // let classifier disambiguate VC / PE / portfolio
          confidence: 0.85,
          name: name || null,
          url,
          data: {
            name,
            legal_name: node.legal_name ?? null,
            description: node.short_description || node.description || null,
            website,
            founded_year: parseFoundedYear(node.founded_on?.value),
            hq_city: hq.city, hq_region: hq.region, hq_country: hq.country,
            sectors: (node.category_groups || []).map((c) => c?.value).filter(Boolean),
            fund_aum: node.funding_total?.value_usd ?? null,
            employee_count_band: node.num_employees_enum ?? null,
            twitter_handle: node.twitter?.value || null,
            linkedin_url: node.linkedin?.value || null,
            crunchbase_url: url,
            contact_email: node.contact_email || null,
          },
        });
      } else {
        // Fallback to OG when __NEXT_DATA__ is absent.
        const name = pickMeta(html, "og:title") || pickTitle(html);
        if (name) candidates.push({
          profile_type: null,
          confidence: 0.4,
          name,
          url,
          data: { name, description: pickMeta(html, "og:description"), crunchbase_url: url },
        });
      }
    } else if (/\/person\//i.test(url)) {
      const node = data ? digPerson(data) : null;
      if (node) {
        const name = [node.first_name, node.last_name].filter(Boolean).join(" ").trim()
          || node.identifier?.value || null;
        candidates.push({
          profile_type: "firm_person",
          confidence: 0.85,
          name,
          url,
          data: {
            name,
            role: node.primary_job_title ?? null,
            firm_employer: node.primary_organization?.value ?? null,
            bio: node.short_description || node.description || null,
            linkedin_url: node.linkedin?.value || null,
            twitter_handle: node.twitter?.value || null,
            crunchbase_url: url,
          },
        });
      }
    }
    const confidence = candidates.reduce((m, c) => Math.max(m, c.confidence), 0);
    return { adapter_id: "crunchbase_public", confidence, candidates, child_urls: child };
  },
};
