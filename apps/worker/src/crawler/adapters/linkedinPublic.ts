// LinkedIn public profile + company adapter.
//
// ETHICS: this adapter only PARSES already-fetched HTML. The crawler
// engine's fetcher is responsible for ethics + rate limits + robots.txt
// compliance. LinkedIn aggressively blocks bots — most live fetches
// will fall back to the generic extractor on an empty body. When a
// public snapshot HTML is supplied (e.g. via the R2 replay path or a
// cached search snippet), this adapter extracts:
//   - JSON-LD Person schema (preferred): name, jobTitle, current
//     employer (worksFor), education list (alumniOf), location
//     (address.*), skills (knowsAbout), description / headline, photo.
//   - __NEXT_DATA__ JSON island: full positions[] array (past roles
//     with company + dates) when present.
//   - OG meta fallback when neither JSON source is available.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { parseAllJsonLd, parseNextData, pickMeta, pickTitle, digFor } from "./_util";

const SLUG_IN_RE = /linkedin\.com\/in\/([A-Za-z0-9._\-%]+)/i;
const SLUG_COMPANY_RE = /linkedin\.com\/company\/([A-Za-z0-9._\-%]+)/i;

function nameFromSlug(slug: string): string {
  const decoded = decodeURIComponent(slug).replace(/-+\d+$/, "").replace(/[-_]+/g, " ").trim();
  return decoded.replace(/\b\w/g, (c) => c.toUpperCase());
}

function asStringArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : (x as { name?: string })?.name)).filter((x): x is string => !!x);
  if (typeof v === "string") return [v];
  return [];
}

interface PositionRow {
  title?: string;
  companyName?: string;
  startedOn?: { year?: number };
  endedOn?: { year?: number };
}

function digPositions(json: unknown): PositionRow[] {
  // The LinkedIn profile blob nests `positions` under pageProps.profile;
  // dig for any object exposing a `positions` array.
  const hit = digFor<{ positions?: PositionRow[] }>(json, (o) => Array.isArray((o as { positions?: unknown }).positions));
  return hit?.positions ?? [];
}

function buildPersonFromJsonLd(node: Record<string, unknown>, url: string, html: string): AdapterCandidate {
  const name = typeof node.name === "string" ? node.name : null;
  const jobTitle = typeof node.jobTitle === "string" ? node.jobTitle : null;
  const description = typeof node.description === "string" ? node.description : (pickMeta(html, "og:description") || null);
  const image = typeof node.image === "string" ? node.image : (pickMeta(html, "og:image") || null);
  const works = node.worksFor as { name?: string; url?: string } | undefined;
  const address = node.address as { addressLocality?: string; addressRegion?: string; addressCountry?: string } | undefined;
  const skills = asStringArr(node.knowsAbout);
  const education = asStringArr(node.alumniOf);
  const slug = SLUG_IN_RE.exec(url)?.[1] ?? "";

  // Mine __NEXT_DATA__ for past positions if the page ships it.
  const positions = digPositions(parseNextData(html));
  const pastRoles = positions
    .filter((p) => (works?.name ? p.companyName !== works.name : true))
    .map((p) => ({
      role: p.title ?? null,
      employer: p.companyName ?? null,
      start_year: p.startedOn?.year ?? null,
      end_year: p.endedOn?.year ?? null,
    }));

  return {
    profile_type: "firm_person",
    confidence: 0.9,
    name,
    url,
    data: {
      name,
      role: jobTitle,
      firm_employer: works?.name ?? null,
      employer_url: works?.url ?? null,
      headline: description,
      location_city: address?.addressLocality ?? null,
      location_region: address?.addressRegion ?? null,
      location_country: address?.addressCountry ?? null,
      education,
      skills,
      past_roles: pastRoles,
      profile_photo: image,
      linkedin_url: url,
      linkedin_slug: slug,
      socials: [{ platform: "linkedin", url }],
    },
  };
}

function parsePersonFromOg(html: string, url: string): AdapterCandidate {
  const title = pickMeta(html, "og:title") || pickTitle(html);
  const desc = pickMeta(html, "og:description") || pickMeta(html, "description") || "";
  const image = pickMeta(html, "og:image");
  const slug = SLUG_IN_RE.exec(url)?.[1] ?? "";
  // Title shapes: "Jane Doe - Partner at Acme - LinkedIn"
  const cleaned = title.replace(/\s*[|\-–—]\s*LinkedIn.*$/i, "").trim();
  const parts = cleaned.split(/\s+[\-–—]\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || nameFromSlug(slug);
  const tail = parts.slice(1).join(" ");
  const at = tail.match(/^(.*?)\s+at\s+(.+)$/i);
  const role = at ? at[1].trim() : (tail || null);
  const org = at ? at[2].trim() : null;
  return {
    profile_type: "firm_person",
    confidence: cleaned ? 0.7 : 0.35,
    name,
    url,
    data: {
      name, role, firm_employer: org,
      headline: desc || null,
      profile_photo: image,
      linkedin_url: url,
      linkedin_slug: slug,
      socials: [{ platform: "linkedin", url }],
    },
  };
}

function parseCompanyFromJsonLd(node: Record<string, unknown>, url: string, html: string): AdapterCandidate {
  const name = typeof node.name === "string" ? node.name : null;
  const description = typeof node.description === "string" ? node.description : (pickMeta(html, "og:description") || null);
  const logo = typeof node.logo === "string" ? node.logo : (pickMeta(html, "og:image") || null);
  const address = node.address as { addressLocality?: string; addressRegion?: string; addressCountry?: string } | undefined;
  const sameAs = asStringArr(node.sameAs);
  const slug = SLUG_COMPANY_RE.exec(url)?.[1] ?? "";
  return {
    profile_type: null,
    confidence: 0.8,
    name,
    url,
    data: {
      name,
      description,
      logo,
      website: typeof node.url === "string" ? node.url : null,
      hq_city: address?.addressLocality ?? null,
      hq_region: address?.addressRegion ?? null,
      hq_country: address?.addressCountry ?? null,
      socials: sameAs.map((u) => ({ platform: "external", url: u })),
      linkedin_url: url,
      linkedin_slug: slug,
    },
  };
}

function parseCompanyFromOg(html: string, url: string): AdapterCandidate {
  const title = pickMeta(html, "og:title") || pickTitle(html);
  const desc = pickMeta(html, "og:description") || pickMeta(html, "description") || "";
  const image = pickMeta(html, "og:image");
  const slug = SLUG_COMPANY_RE.exec(url)?.[1] ?? "";
  const name = title.replace(/\s*[|\-–—]\s*LinkedIn.*$/i, "").trim() || nameFromSlug(slug);
  return {
    profile_type: null,
    confidence: title ? 0.55 : 0.3,
    name,
    url,
    data: {
      name, description: desc || null, logo: image,
      linkedin_url: url, linkedin_slug: slug,
    },
  };
}

export const linkedinPublic: SiteAdapter = {
  id: "linkedin_public",
  priority: 90,
  hosts: ["linkedin.com", "www.linkedin.com"],
  url_patterns: [/\/in\/[^/]+/i, /\/company\/[^/]+/i, /\/pub\/[^/]+/i],
  profile_types_emitted: ["firm_person"],
  extract(html, url): AdapterResult {
    const candidates: AdapterCandidate[] = [];
    const isPerson = SLUG_IN_RE.test(url);
    const isCompany = SLUG_COMPANY_RE.test(url);

    // Prefer JSON-LD Person/Organization schema when present.
    let usedJsonLd = false;
    for (const node of parseAllJsonLd(html)) {
      const t = node["@type"];
      const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
      if (isPerson && types.includes("Person")) {
        candidates.push(buildPersonFromJsonLd(node, url, html));
        usedJsonLd = true;
      } else if (isCompany && (types.includes("Organization") || types.includes("Corporation"))) {
        candidates.push(parseCompanyFromJsonLd(node, url, html));
        usedJsonLd = true;
      }
    }
    if (!usedJsonLd && isPerson) candidates.push(parsePersonFromOg(html, url));
    if (!usedJsonLd && isCompany) candidates.push(parseCompanyFromOg(html, url));
    const confidence = candidates.reduce((m, c) => Math.max(m, c.confidence), 0);
    return { adapter_id: "linkedin_public", confidence, candidates, child_urls: [] };
  },
};
