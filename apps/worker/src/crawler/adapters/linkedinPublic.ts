// LinkedIn public profile + company adapter.
//
// ETHICS: this adapter only PARSES already-fetched HTML. The crawler
// engine's fetcher is responsible for ethics + rate limits + robots.txt
// compliance. LinkedIn aggressively blocks bots — most live fetches
// will fall back to the generic extractor on an empty body. When a
// public snapshot HTML is supplied (e.g. via the R2 replay path or a
// cached search snippet), this adapter parses it.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { parseAllJsonLd, pickMeta, pickTitle } from "./_util";

const SLUG_IN_RE = /linkedin\.com\/in\/([A-Za-z0-9._\-%]+)/i;
const SLUG_COMPANY_RE = /linkedin\.com\/company\/([A-Za-z0-9._\-%]+)/i;

function nameFromSlug(slug: string): string {
  const decoded = decodeURIComponent(slug).replace(/-+\d+$/, "").replace(/[-_]+/g, " ").trim();
  return decoded.replace(/\b\w/g, (c) => c.toUpperCase());
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
      name,
      role,
      firm_employer: org,
      headline: desc || null,
      profile_photo: image,
      linkedin_url: url,
      linkedin_slug: slug,
      socials: [{ platform: "linkedin", url }],
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
    profile_type: null, // generic org — let downstream classify (investor_vc, public_company, ...).
    confidence: title ? 0.55 : 0.3,
    name,
    url,
    data: {
      name,
      description: desc || null,
      logo: image,
      linkedin_url: url,
      linkedin_slug: slug,
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
    // Prefer JSON-LD when present (rare on LinkedIn but possible on
    // public profile snapshots).
    for (const node of parseAllJsonLd(html)) {
      const t = node["@type"];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes("Person")) {
        candidates.push({
          profile_type: "firm_person",
          confidence: 0.85,
          name: typeof node.name === "string" ? node.name : null,
          url,
          data: { ...node, linkedin_url: url },
        });
      }
    }
    if (SLUG_IN_RE.test(url)) candidates.push(parsePersonFromOg(html, url));
    if (SLUG_COMPANY_RE.test(url)) candidates.push(parseCompanyFromOg(html, url));
    const confidence = candidates.reduce((m, c) => Math.max(m, c.confidence), 0);
    return { adapter_id: "linkedin_public", confidence, candidates, child_urls: [] };
  },
};
