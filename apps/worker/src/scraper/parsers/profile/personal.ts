// Personal-site parser. Reuses Task #17's 8-strategy `personExtract` so a
// single-person homepage benefits from the same JSON-LD / OG / microformat
// / mailto / image-alt / regex coverage as a VC firm team page. We also
// optionally probe a small set of secondary paths (`/about`, `/contact`,
// `/now`) so a one-page bio that lives on a sub-page still resolves.

import type { Env, ParsedLead } from "../../../types";
import type { FetchResult } from "../../fetcher";
import { fetchPage } from "../../fetcher";
import { extractDomain, normalizeEmail } from "../../normalize";
import { extractEmails, extractSocialLinks, extractTitle } from "../../html";
import { extractPeopleFromPage } from "../../firmcrawl/personExtract";

const SECONDARY_PATHS = ["/about", "/contact", "/now"];

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

function leadsFromPage(
  html: string,
  url: string,
  sourceUrl: string,
  pageFetchedFrom: "live" | "wayback",
): ParsedLead[] {
  const source_domain = extractDomain(sourceUrl);
  const people = extractPeopleFromPage(html, url, source_domain ?? null);
  const pageEmails = extractEmails(html).map(normalizeEmail).filter((e): e is string => Boolean(e));
  const pageSocials = extractSocialLinks(html, url);
  const title = extractTitle(html);

  // `_fetched_from` is a private hint consumed by processProfileUrl so each
  // lead is attributed to the page it was actually extracted from (the
  // primary page may be wayback while a /about probe is live, or vice versa).
  const baseMeta = (extra: Record<string, unknown> = {}) => ({
    parser: "profile/personal",
    probed_url: url,
    _fetched_from: pageFetchedFrom,
    socials: pageSocials,
    ...extra,
  });

  if (people.length === 0) {
    if (pageEmails.length === 0) {
      return [{
        source_domain,
        source_url: sourceUrl,
        name: title ?? undefined,
        category: "personal_site",
        meta: baseMeta(),
      }];
    }
    return pageEmails.map((email) => ({
      source_domain,
      source_url: sourceUrl,
      name: title ?? undefined,
      email,
      category: "personal_site",
      meta: baseMeta(),
    }));
  }

  return people.map((p) => ({
    source_domain,
    source_url: sourceUrl,
    name: p.name,
    email: p.email ?? undefined,
    title: p.role ?? undefined,
    category: "personal_site",
    meta: baseMeta({
      bio: p.bio,
      avatar: p.avatar,
      source_strategy: p.source_strategy,
      socials: [
        ...pageSocials,
        ...(p.linkedin ? [{ platform: "linkedin", url: p.linkedin }] : []),
        ...(p.twitter ? [{ platform: "twitter", url: p.twitter }] : []),
        ...(p.crunchbase ? [{ platform: "crunchbase", url: p.crunchbase }] : []),
        ...(p.personal_site ? [{ platform: "personal", url: p.personal_site }] : []),
      ],
    }),
  }));
}

export interface PersonalParseResult {
  leads: ParsedLead[];
  /** All pages we successfully fetched (primary + secondary probes). */
  fetched: Array<{ result: FetchResult; url: string }>;
}

export function parsePersonalSync(html: string, url: string): ParsedLead[] {
  return leadsFromPage(html, url, url, "live");
}

export async function parsePersonal(
  env: Env,
  url: string,
  jobId: string,
  primary: FetchResult,
): Promise<PersonalParseResult> {
  const fetched: Array<{ result: FetchResult; url: string }> = [{ result: primary, url }];
  // Run the strategies on the primary page first so we have something to
  // return even if every secondary probe fails.
  const leadsByKey = new Map<string, ParsedLead>();
  const ingest = (page: ParsedLead[]) => {
    for (const l of page) {
      const k = (l.name ?? l.email ?? l.source_url).toLowerCase();
      if (!leadsByKey.has(k)) leadsByKey.set(k, l);
    }
  };
  ingest(leadsFromPage(primary.html, primary.url || url, url, primary.fetched_from === "wayback" ? "wayback" : "live"));

  // Secondary probes: small, capped, Tier-0 only, no escalation. We don't
  // re-parse pages we already fetched (the primary may already BE /about).
  const origin = originOf(url);
  const seen = new Set<string>([(primary.url || url).toLowerCase()]);
  if (origin) {
    for (const path of SECONDARY_PATHS) {
      const probeUrl = `${origin}${path}`;
      if (seen.has(probeUrl.toLowerCase())) continue;
      seen.add(probeUrl.toLowerCase());
      try {
        const r = await fetchPage(env, probeUrl, { jobId, minIntervalMs: 1500, liveOnly: true });
        if (r.ok && r.html && r.fetched_from === "live") {
          fetched.push({ result: r, url: probeUrl });
          ingest(leadsFromPage(r.html, r.url || probeUrl, url, "live"));
        }
      } catch {
        // probe failure is non-fatal
      }
    }
  }

  return { leads: Array.from(leadsByKey.values()), fetched };
}
