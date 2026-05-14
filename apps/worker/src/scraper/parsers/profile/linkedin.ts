// LinkedIn profile snippet extractor.
//
// Critical rule: we NEVER fetch linkedin.com directly (LinkedIn's ToS
// forbids automated access and they aggressively block scrapers). Instead
// we route through Task 4's search-engine facade (`discovery/searx`) and
// pull the title + description from the public search snippet. The
// resulting lead carries `meta_json.linkedin_snippet_only=true` so
// downstream consumers know the profile was not fully scraped.

import type { Env, ParsedLead } from "../../../types";
import { extractDomain } from "../../normalize";
import { search } from "../../../discovery/searx";

const SLUG_RE = /linkedin\.com\/in\/([A-Za-z0-9._\-%]+)/i;

export function isLinkedInProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/in\/[^/]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

function nameFromSlug(slug: string): string | undefined {
  const decoded = decodeURIComponent(slug)
    .replace(/-+\d+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!decoded) return undefined;
  return decoded.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseTitleSnippet(title: string): { name?: string; titleRole?: string; org?: string } {
  // Common LinkedIn title shapes, e.g.:
  //   "Jane Doe - Partner at Acme - LinkedIn"
  //   "Jane Doe — Partner — Acme | LinkedIn"
  //   "Jane Doe | LinkedIn"
  const cleaned = title.replace(/\s*[\|\-–—]\s*LinkedIn.*$/i, "").trim();
  if (!cleaned) return {};
  const parts = cleaned.split(/\s+[\-–—]\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const name = parts[0];
  const tail = parts.slice(1).join(" ");
  const at = tail.match(/^(.*?)\s+at\s+(.+)$/i);
  if (at) return { name, titleRole: at[1].trim(), org: at[2].trim() };
  return { name, titleRole: tail || undefined };
}

export async function parseLinkedIn(env: Env, url: string): Promise<ParsedLead[]> {
  const slug = SLUG_RE.exec(url)?.[1] ?? null;
  const fallbackName = slug ? nameFromSlug(slug) : undefined;
  let title = "";
  let snippet = "";
  try {
    const hits = await search(env, `site:linkedin.com/in ${slug ?? url}`, 5);
    const hit =
      hits.find((h) => h.url.toLowerCase().includes((slug ?? "").toLowerCase())) ??
      hits.find((h) => /linkedin\.com\/in\//i.test(h.url));
    if (hit) {
      title = hit.title || "";
      snippet = hit.snippet || "";
    }
  } catch {
    // Search failure leaves us with the slug-derived name only.
  }
  const parsed = parseTitleSnippet(title);
  const name = parsed.name ?? fallbackName;
  return [
    {
      source_domain: extractDomain(url),
      source_url: url,
      name,
      title: parsed.titleRole,
      org: parsed.org,
      category: "linkedin_profile",
      meta: {
        parser: "profile/linkedin",
        linkedin_url: url,
        linkedin_snippet_only: true,
        snippet: snippet || null,
        snippet_title: title || null,
        socials: [{ platform: "linkedin", url }],
      },
    },
  ];
}
