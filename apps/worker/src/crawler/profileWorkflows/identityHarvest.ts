// Task #7: deterministic identity harvester.
//
// Scans already-fetched HTML for a person's own contact points — email
// addresses (mailto: links + inline text) and social / web profile URLs
// (LinkedIn, Twitter/X, GitHub, personal website) — and emits them as the
// canonical BARE contact predicates (`email`, `linkedin_url`,
// `twitter_url`, `github_url`, `website`) defined in
// `entities/profile-predicates.ts`. These land in the same `facts`
// vocabulary the UI already knows how to render.
//
// No AI and no external services: this is a pure regex pass over HTML the
// crawler already fetched. It is honest about finding nothing — an empty
// array means no contact points were present on the page, never a guess.
//
// The same regex strategy is used by the firm people-extractor
// (`scraper/firmcrawl/personExtract.ts`); here it is tuned for a single
// person's own page rather than a firm team grid, so emails are accepted
// without a co-located name heading.

import type { FactCandidate, PlannedSource } from "./_types";

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const MAILTO_RE = /href\s*=\s*["']mailto:([^"'?>\s]+)/gi;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9._\-%]+/gi;
const TWITTER_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/gi;
const GITHUB_RE = /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/gi;

// Generic mailboxes that are not a specific person's address.
const ROLE_INBOX_RE = /^(?:info|contact|hello|hi|enquir(?:y|ies)|inquir(?:y|ies)|press|admin|administrator|support|help|helpdesk|jobs|careers|hiring|recruiting|recruitment|hr|noreply|no-reply|donotreply|sales|team|office|media|webmaster|postmaster|hostmaster|abuse|billing|accounts|legal|privacy|security|marketing|newsletter|subscribe|general|mail|email|service|services|feedback)$/i;

// Domains that look like emails but are file references or placeholders.
const NON_EMAIL_DOMAIN_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf)$/i;
const PLACEHOLDER_EMAIL_RE = /@(?:example\.(?:com|org|net)|domain\.com|email\.com|yourdomain\.|sentry\.io|wixpress\.com|2x\.)/i;

// GitHub paths that are product routes, not user profiles.
const GITHUB_RESERVED = new Set([
  "about", "features", "pricing", "enterprise", "team", "marketplace", "explore",
  "topics", "trending", "collections", "events", "sponsors", "readme", "search",
  "login", "join", "settings", "notifications", "new", "orgs", "apps", "site",
  "security", "contact", "pulls", "issues", "marketplace", "customer-stories",
]);

// Twitter/X reserved handles that are platform routes, not people.
const TWITTER_RESERVED = new Set([
  "home", "search", "explore", "settings", "i", "intent", "share", "hashtag",
  "compose", "messages", "notifications", "login", "signup", "about", "tos",
  "privacy", "help", "download", "status",
]);

/** Validate + normalize an email address. Returns null for role inboxes,
 *  file-reference look-alikes, and placeholders. */
export function cleanEmail(raw: string): string | null {
  if (!raw) return null;
  const addr = raw.split("?")[0].trim().toLowerCase();
  const at = addr.indexOf("@");
  if (at < 1) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!local || !domain || !domain.includes(".")) return null;
  if (addr.includes("..")) return null;
  if (NON_EMAIL_DOMAIN_RE.test(domain)) return null;
  if (PLACEHOLDER_EMAIL_RE.test(addr)) return null;
  if (isRoleInbox(addr)) return null;
  if (addr.length > 254) return null;
  // Final structural check against the canonical pattern.
  EMAIL_RE.lastIndex = 0;
  if (!EMAIL_RE.test(addr)) return null;
  return addr;
}

/** True when the email's local part is a generic, non-personal mailbox. */
export function isRoleInbox(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return ROLE_INBOX_RE.test(local);
}

function stripChrome(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function normalizeProfileUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/[#?].*$/, "");      // drop fragment + query
  u = u.replace(/\/+$/, "");          // drop trailing slash(es)
  return u;
}

function lastPathSegment(url: string): string {
  const m = url.replace(/[#?].*$/, "").replace(/\/+$/, "").split("/");
  return (m[m.length - 1] ?? "").toLowerCase();
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return null; }
}

// Hosts that are social platforms, not a personal website.
const PLATFORM_HOST_RE = /(?:linkedin\.com|twitter\.com|x\.com|github\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|crunchbase\.com|wikipedia\.org|t\.me|tiktok\.com)$/i;

/**
 * Harvest contact points from one fetched page.
 *
 * @param html       raw HTML of the page
 * @param source     the planned source (carries tag + url for provenance)
 * @param opts.selfUrl  the candidate's own page URL; when its host is not a
 *                      known social platform it is emitted as `website`.
 */
export function harvestIdentityFacts(
  html: string,
  source: PlannedSource,
  opts: { selfUrl?: string } = {},
): FactCandidate[] {
  if (!html) return [];
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  const conf = 0.6; // deterministic scrape; crossRef may promote on agreement.

  const push = (predicate: string, valueText: string): void => {
    const key = `${predicate}::${valueText.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ predicate, valueText, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
  };

  const text = stripChrome(html);

  // ---- Emails: mailto: links first (highest-signal), then inline text.
  const emails = new Set<string>();
  let m: RegExpExecArray | null;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(html)) !== null) {
    const e = cleanEmail(decodeURIComponent(m[1]));
    if (e) emails.add(e);
  }
  for (const em of text.matchAll(EMAIL_RE)) {
    const e = cleanEmail(em[0]);
    if (e) emails.add(e);
  }
  for (const e of emails) push("email", e);

  // ---- LinkedIn.
  for (const lm of html.matchAll(LINKEDIN_RE)) {
    push("linkedin_url", normalizeProfileUrl(lm[0]));
  }

  // ---- Twitter / X.
  for (const tm of html.matchAll(TWITTER_RE)) {
    const url = normalizeProfileUrl(tm[0]);
    if (TWITTER_RESERVED.has(lastPathSegment(url))) continue;
    push("twitter_url", url);
  }

  // ---- GitHub (profile URLs only — skip product routes + repo subpaths).
  for (const gm of html.matchAll(GITHUB_RE)) {
    const url = normalizeProfileUrl(gm[0]);
    const seg = lastPathSegment(url);
    if (!seg || GITHUB_RESERVED.has(seg)) continue;
    // Must be a top-level /<user> path (one segment after the host).
    const path = url.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "");
    if (path.includes("/")) continue;
    push("github_url", url);
  }

  // ---- Personal website: the candidate's own page, when it isn't a
  //      social platform host.
  if (opts.selfUrl) {
    const host = hostOf(opts.selfUrl);
    if (host && !PLATFORM_HOST_RE.test(host)) {
      push("website", `https://${host}`);
    }
  }

  return out;
}
