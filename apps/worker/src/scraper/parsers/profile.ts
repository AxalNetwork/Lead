// Profile-aware URL dispatcher. Replaces the legacy `generic.ts` default
// parser. The pipeline calls `dispatchProfile` BEFORE the standard
// fetch-then-parse flow because several profile types need special
// handling that the tiered fetcher can't do generically:
//
//   * `linkedin.com/in/{slug}` — never fetched directly; routed through
//     Task #4 search-engine discovery (snippet only).
//   * `x.com/{handle}` & `twitter.com/{handle}` — rewritten to the public
//     Nitter mirror before fetching.
//   * `github.com/{user}` — uses the GitHub REST API instead of HTML.
//   * `signal.nfx.com/*` — gated source; rejected outright.
//   * `crunchbase.com/person/{slug}` — fetch via tiered fetcher, then
//     parse `__NEXT_DATA__` JSON for identifier/title/org/location.
//   * `crunchbase.com/organization/{slug}` — fetch then route to the new
//     `crunchbase-org` parser which returns a `FirmCandidate` (persisted
//     via `upsertFirm`) instead of a person lead.
//   * Personal site (catch-all) — fetch primary + probe `/about`,
//     `/contact`, `/now` and run the Task #17 8-strategy person extractor.
//
// The result also exposes outbound URLs for depth-1 fanout (the pipeline
// enqueues each as a `kind='url'` child with `depth=1` so they don't fan
// out further).

import type { Env, ParsedLead } from "../../types";
import type { FetchResult } from "../fetcher";
import { fetchPage } from "../fetcher";
import type { FirmCandidate } from "./firmlists/types";

import { isLinkedInProfileUrl, parseLinkedIn } from "./profile/linkedin";
import { isCrunchbasePersonUrl, parseCrunchbasePerson } from "./profile/crunchbase-person";
import { isCrunchbaseOrgUrl, parseCrunchbaseOrg } from "./profile/crunchbase-org";
import { isTwitterProfileUrl, parseTwitter } from "./profile/nitter";
import { isGithubProfileUrl, parseGithub } from "./profile/github";
import { parsePersonal, parsePersonalSync } from "./profile/personal";
import { isNfxProfileUrl, NFX_ERROR } from "./profile/nfx";

export type ProfileKind =
  | "linkedin"
  | "crunchbase_person"
  | "crunchbase_org"
  | "twitter"
  | "github"
  | "nfx"
  | "personal";

export interface ProfileDispatchResult {
  kind: ProfileKind;
  leads: ParsedLead[];
  firmCandidate?: FirmCandidate;
  /** Outbound URLs harvested for depth-1 fanout. */
  outboundUrls: string[];
  pagesFetched: number;
  pagesBlocked: number;
  captchaHits: number;
  costMs: number;
  /** Primary page fetched (if any) — used by the pipeline for R2 archival. */
  fetched: FetchResult | null;
  /** Additional live pages fetched by personal-site `/about` `/contact` `/now`
   * probes. Pipeline archives each so the dashboard reflects every byte. */
  extraFetched?: Array<{ result: FetchResult; url: string }>;
}

export function detectProfileKind(url: string): ProfileKind {
  if (isNfxProfileUrl(url)) return "nfx";
  if (isLinkedInProfileUrl(url)) return "linkedin";
  if (isCrunchbasePersonUrl(url)) return "crunchbase_person";
  if (isCrunchbaseOrgUrl(url)) return "crunchbase_org";
  if (isTwitterProfileUrl(url)) return "twitter";
  if (isGithubProfileUrl(url)) return "github";
  return "personal";
}

const SOCIAL_HOSTS = new Set([
  "linkedin.com",
  "twitter.com",
  "x.com",
  "github.com",
  "crunchbase.com",
  "instagram.com",
  "facebook.com",
  "youtube.com",
  "tiktok.com",
  "medium.com",
  "substack.com",
]);

function urlHost(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function collectOutboundFromLeads(leads: ParsedLead[], primaryUrl: string): string[] {
  const out = new Set<string>();
  const primaryHost = urlHost(primaryUrl);
  for (const l of leads) {
    const meta = l.meta ?? {};
    const socials = (meta.socials as Array<{ url?: string }> | undefined) ?? [];
    for (const s of socials) {
      if (!s?.url) continue;
      const host = urlHost(s.url);
      if (!host) continue;
      // Always allow socials on different hosts (these are the outbound
      // links the spec wants us to follow). Skip same-host links.
      if (host === primaryHost) continue;
      // Restrict to recognized social platforms or generic personal
      // sites — avoid pulling random analytics / ad pixels into fanout.
      const known = [...SOCIAL_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));
      if (!known) {
        // Allow personal-domain links surfaced as `platform=personal`.
        const platform = (s as { platform?: string }).platform;
        if (platform !== "personal" && platform !== "website") continue;
      }
      out.add(s.url);
    }
    const blog = (meta.blog as string | undefined) || (meta.website as string | undefined);
    if (blog) {
      const host = urlHost(blog);
      if (host && host !== primaryHost) out.add(blog.startsWith("http") ? blog : `https://${blog}`);
    }
  }
  return Array.from(out);
}

/**
 * URL-aware dispatcher used by the pipeline for `kind='url'` jobs. Owns
 * its own fetching strategy (LinkedIn skips fetch entirely; Twitter
 * rewrites to Nitter; GitHub hits the REST API). Returns leads + outbound
 * URLs for depth-1 fanout. Throws with `NFX_ERROR` for gated sources.
 */
export async function dispatchProfile(env: Env, url: string, jobId: string): Promise<ProfileDispatchResult> {
  const kind = detectProfileKind(url);
  const start = Date.now();

  if (kind === "nfx") {
    throw new Error(NFX_ERROR);
  }

  if (kind === "linkedin") {
    const leads = await parseLinkedIn(env, url);
    return {
      kind, leads, outboundUrls: [],
      pagesFetched: 0, pagesBlocked: 0, captchaHits: 0,
      costMs: Date.now() - start, fetched: null,
    };
  }

  if (kind === "github") {
    const r = await parseGithub(env, url, jobId);
    return {
      kind, leads: r.leads,
      outboundUrls: collectOutboundFromLeads(r.leads, url),
      pagesFetched: r.ok ? 1 : 0, pagesBlocked: r.ok ? 0 : 1,
      captchaHits: 0, costMs: Date.now() - start, fetched: null,
    };
  }

  if (kind === "twitter") {
    const r = await parseTwitter(env, url, jobId);
    return {
      kind, leads: r.leads,
      outboundUrls: collectOutboundFromLeads(r.leads, url),
      pagesFetched: r.fetched?.ok ? 1 : 0,
      pagesBlocked: r.fetched && !r.fetched.ok ? 1 : 0,
      captchaHits: r.fetched?.blockReason === "captcha" ? 1 : 0,
      costMs: Date.now() - start, fetched: r.fetched,
    };
  }

  // Remaining kinds (crunchbase_person, crunchbase_org, personal) all
  // need the standard tiered fetcher.
  const fetched = await fetchPage(env, url, { jobId });
  if (!fetched.ok) {
    throw new Error(`fetch_failed:${fetched.blockReason ?? "unknown"}:status=${fetched.status}`);
  }

  if (kind === "crunchbase_person") {
    const leads = parseCrunchbasePerson(fetched.html, fetched.url || url);
    return {
      kind, leads,
      outboundUrls: collectOutboundFromLeads(leads, url),
      pagesFetched: 1, pagesBlocked: 0, captchaHits: 0,
      costMs: Date.now() - start, fetched,
    };
  }

  if (kind === "crunchbase_org") {
    const firm = parseCrunchbaseOrg(fetched.html, fetched.url || url);
    return {
      kind, leads: [],
      firmCandidate: firm ?? undefined,
      outboundUrls: [],
      pagesFetched: 1, pagesBlocked: 0, captchaHits: 0,
      costMs: Date.now() - start, fetched,
    };
  }

  // Personal site — primary + secondary probes via personExtract.
  const personal = await parsePersonal(env, url, jobId, fetched);
  // First entry of personal.fetched is the primary; expose the rest as
  // `extraFetched` so processProfileUrl can archive each probe page.
  const extras = personal.fetched.slice(1);
  return {
    kind: "personal",
    leads: personal.leads,
    outboundUrls: collectOutboundFromLeads(personal.leads, url),
    pagesFetched: personal.fetched.length,
    pagesBlocked: 0,
    captchaHits: 0,
    costMs: Date.now() - start,
    fetched,
    extraFetched: extras.length ? extras : undefined,
  };
}

/**
 * Sync HTML→leads parser. Used as the registered PARSERS["profile"] and
 * the post-fetch fallback when a non-profile URL falls through to the
 * default. Routes Crunchbase person HTML to the JSON-aware parser; all
 * other shapes go through the personal-site path.
 */
export function parse(html: string, url: string): ParsedLead[] {
  if (isCrunchbasePersonUrl(url)) return parseCrunchbasePerson(html, url);
  return parsePersonalSync(html, url);
}
