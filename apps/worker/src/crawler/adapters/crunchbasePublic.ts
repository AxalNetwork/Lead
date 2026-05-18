// Crunchbase public organization / person page adapter. Parses the
// embedded __NEXT_DATA__ JSON island that ships with every Crunchbase
// page render. Extracts: org basics, recent funding rounds (round,
// date, amount USD, lead investors), and the people list (so a single
// org page hydrates both the firm and its team in one pass).

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { parseNextData, digFor, digAll, pickMeta, pickTitle } from "./_util";

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

interface FundingRoundNode {
  identifier?: { value?: string };
  investment_type?: string;
  announced_on?: { value?: string };
  money_raised?: { value_usd?: number; value?: number; currency?: string };
  lead_investors?: Array<{ value?: string }>;
}

function digOrg(json: unknown): OrgNode | null {
  return digFor<OrgNode>(json, (o) =>
    !!o.identifier && (!!o.short_description || !!o.website || !!o.homepage_url || !!o.category_groups));
}

function digPerson(json: unknown): PersonNode | null {
  return digFor<PersonNode>(json, (o) =>
    !!o.identifier && (!!o.first_name || !!o.last_name) && !!o.primary_job_title);
}

function digFundingRounds(json: unknown): FundingRoundNode[] {
  return digAll<FundingRoundNode>(json, (o) =>
    !!o.investment_type && (!!o.announced_on || !!o.money_raised));
}

function digPeople(json: unknown): PersonNode[] {
  // People on org pages: any node with first_name + last_name. Crunchbase
  // sometimes nests the slug under `identifier.permalink` and sometimes
  // emits a flat top-level `permalink`, so we accept either.
  return digAll<PersonNode>(json, (o) =>
    !!o.first_name && !!o.last_name && !o.investment_type
    && (!!o.identifier || typeof o.permalink === "string"));
}

function personPermalink(p: PersonNode & { permalink?: string }): string | null {
  return p.identifier?.permalink || p.permalink || null;
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

function mapRound(r: FundingRoundNode): {
  round: string | null; date: string | null;
  amount_usd: number | null; lead_investors: string[];
} {
  return {
    round: r.identifier?.value || r.investment_type || null,
    date: r.announced_on?.value ?? null,
    amount_usd: r.money_raised?.value_usd ?? null,
    lead_investors: (r.lead_investors || []).map((x) => x?.value).filter((x): x is string => !!x),
  };
}

export const crunchbasePublic: SiteAdapter = {
  id: "crunchbase_public",
  priority: 85,
  hosts: ["crunchbase.com", "www.crunchbase.com"],
  url_patterns: [/^\/organization\/[^/]+/i, /^\/person\/[^/]+/i, /^\/funding_round\/[^/]+/i],
  profile_types_emitted: ["firm_person", "investor_vc", "investor_pe", "portfolio_company"],
  extract(html, url): AdapterResult {
    const candidates: AdapterCandidate[] = [];
    const childUrls: string[] = [];
    const data = parseNextData(html);
    if (/\/organization\//i.test(url)) {
      const node = data ? digOrg(data) : null;
      if (node) {
        const name = node.identifier?.value || pickMeta(html, "og:title") || pickTitle(html);
        const website = node.website?.value || node.homepage_url?.value || null;
        const hq = pickHq(node);
        const rounds = (data ? digFundingRounds(data) : []).map(mapRound);
        const people = (data ? digPeople(data) : []);
        candidates.push({
          profile_type: null, // let classifier disambiguate VC / PE / portfolio
          confidence: 0.9,
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
            total_funding_usd: node.funding_total?.value_usd ?? null,
            num_funding_rounds: node.num_funding_rounds ?? rounds.length,
            funding_rounds: rounds,
            employee_count_band: node.num_employees_enum ?? null,
            twitter_handle: node.twitter?.value || null,
            linkedin_url: node.linkedin?.value || null,
            crunchbase_url: url,
            contact_email: node.contact_email || null,
          },
        });
        // Surface each person as a separate candidate so the predicate
        // router can hydrate the team in the same crawl.
        for (const p of people) {
          const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
          if (!fullName) continue;
          const slug = personPermalink(p);
          const personUrl = slug ? `https://www.crunchbase.com/person/${slug}` : url;
          if (personUrl !== url) childUrls.push(personUrl);
          candidates.push({
            profile_type: "firm_person",
            confidence: 0.75,
            name: fullName,
            url: personUrl,
            data: {
              name: fullName,
              role: p.primary_job_title ?? null,
              firm_employer: node.identifier?.value ?? null,
              linkedin_url: p.linkedin?.value || null,
              twitter_handle: p.twitter?.value || null,
              crunchbase_url: personUrl,
            },
          });
        }
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
    return { adapter_id: "crunchbase_public", confidence, candidates, child_urls: childUrls };
  },
};
