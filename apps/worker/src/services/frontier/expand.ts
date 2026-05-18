// Task #3: Smart frontier expander.
//
// Takes a crawled page + its extracted outbound links and emits next-URL
// candidates tagged with a `discovery_reason`. Each candidate is persisted
// into `smart_frontier` with a priority computed as:
//
//   priority = reasonWeight[reason] * source_authority * novelty_score
//
// `source_authority` is the existing news/reputability lookup for the
// source host (default 0.4 for unknown hosts). `novelty_score` decays from
// 1.0 toward 0 as the URL has been seen more recently in `smart_frontier`
// or `discovered_urls`.
//
// Bounded fanout: per-profile-type, per-cycle cap of 500 candidates so
// one prolific seed cannot starve other types.

import type { Env } from "../../types";
import { canonicalizeUrl, isObviousReject, sameSite } from "../../discovery/canonical";
import { getReputability, REPUTABILITY_DEFAULT } from "../../news/reputability";

export type DiscoveryReason =
  | "linked_team_member"
  | "linked_portfolio_company"
  | "linked_publication"
  | "same_domain_about_page"
  | "linked_external_press"
  | "linked_social_handle"
  | "mentioned_email_domain";

export const REASON_WEIGHTS: Record<DiscoveryReason, number> = {
  linked_team_member:        1.0,
  linked_portfolio_company:  1.0,
  linked_social_handle:      0.9,
  linked_publication:        0.6,
  same_domain_about_page:    0.6,
  mentioned_email_domain:    0.5,
  linked_external_press:     0.3,
};

const SOCIAL_HOSTS_RE = /^(twitter|x|linkedin|github|instagram|facebook|youtube|threads|mastodon|bsky)\.(com|app|social|com\.br)$/i;
const TEAM_PATH_RE = /\/(team|people|about|leadership|partners|staff|founders?|members?|board|advisors?)(\/|$)/i;
const PORTFOLIO_PATH_RE = /\/(portfolio|companies?|investments?)(\/|$)/i;
const PUBLICATION_PATH_RE = /\/(blog|news|press|insights?|essays|writings?|substack|publication|articles?)(\/|$)/i;
const ABOUT_PATH_RE = /\/(about|company|story|mission|who-we-are)(\/|$)/i;
const PRESS_OUTLET_RE = /\b(techcrunch|wsj|nytimes|bloomberg|reuters|forbes|fortune|theinformation|axios|wired|verge|cnbc|economist|ft\.com|coindesk)\b/i;

export interface ExpandInput {
  sourceUrl: string;                                          // the page that was crawled
  sourceHost?: string | null;
  profileTypeId?: string | null;                              // tag for downstream queue routing
  links: Array<{ url: string; anchor?: string | null; context?: string | null }>;
  emails?: string[];                                          // mentioned email addresses (for mentioned_email_domain)
}

export interface FrontierCandidate {
  url: string;
  url_canonical: string;
  host: string;
  profile_type_id: string | null;
  discovery_reason: DiscoveryReason;
  priority: number;
  source_url: string;
  source_authority: number;
  novelty_score: number;
}

const MAX_PER_TYPE_PER_CYCLE = 500;

// classifyReason — deterministic; runs before any DB call so callers can
// preview what the expander would emit without writing.
export function classifyReason(opts: {
  link: { url: string; anchor?: string | null };
  canonical: string;
  host: string;
  sourceHost: string;
}): DiscoveryReason | null {
  const anchor = String(opts.link.anchor ?? "").toLowerCase();
  const path = (() => { try { return new URL(opts.canonical).pathname.toLowerCase(); } catch { return ""; } })();

  // Social handles — same host detection happens first because a same-site
  // /team link is almost always more valuable than a social link.
  if (SOCIAL_HOSTS_RE.test(opts.host)) return "linked_social_handle";

  // Same-site signals.
  if (sameSite(opts.host, opts.sourceHost)) {
    if (TEAM_PATH_RE.test(path) || /\b(team|people|partners|leadership|biography|founder)\b/.test(anchor)) {
      return "linked_team_member";
    }
    if (PORTFOLIO_PATH_RE.test(path) || /\b(portfolio|companies|investments|portco)\b/.test(anchor)) {
      return "linked_portfolio_company";
    }
    if (ABOUT_PATH_RE.test(path) || /\babout\b/.test(anchor)) {
      return "same_domain_about_page";
    }
    if (PUBLICATION_PATH_RE.test(path)) {
      return "linked_publication";
    }
    return null;
  }

  // Cross-site signals.
  if (PRESS_OUTLET_RE.test(opts.host)) return "linked_external_press";
  if (PUBLICATION_PATH_RE.test(path) || /\b(blog|essay|article|read more)\b/.test(anchor)) return "linked_publication";

  return null;
}

// noveltyScore — 1.0 for URLs we have never seen; decays toward 0 as the
// URL has been seen more recently. We look in `smart_frontier` first
// (recent traffic) and fall back to `discovered_urls.last_seen`.
async function noveltyScore(env: Env, urlCanonical: string): Promise<number> {
  try {
    const sf = await env.DB.prepare(
      `SELECT discovered_at FROM smart_frontier WHERE url_canonical = ? ORDER BY discovered_at DESC LIMIT 1`,
    ).bind(urlCanonical).first<{ discovered_at: string }>();
    if (sf?.discovered_at) {
      const ageDays = Math.max(0, (Date.now() - Date.parse(sf.discovered_at + "Z")) / 86400000);
      // Half-life ~7 days: novelty 0.5 at 7d, 0.25 at 14d, etc.
      return Math.max(0.05, 1 / (1 + ageDays / 7));
    }
  } catch { /* table may not exist in tests */ }
  try {
    const du = await env.DB.prepare(
      `SELECT last_seen FROM discovered_urls WHERE url_canonical = ?`,
    ).bind(urlCanonical).first<{ last_seen: string }>();
    if (du?.last_seen) {
      const ageDays = Math.max(0, (Date.now() - Date.parse(du.last_seen + "Z")) / 86400000);
      return Math.max(0.1, 1 / (1 + ageDays / 14));
    }
  } catch { /* table may not exist */ }
  return 1.0;
}

export async function buildCandidates(env: Env, input: ExpandInput): Promise<FrontierCandidate[]> {
  const srcCanon = canonicalizeUrl(input.sourceUrl);
  if (!srcCanon) return [];
  const sourceHost = (input.sourceHost ?? srcCanon.host).toLowerCase();
  const sourceRep = await getReputability(env, sourceHost).catch(() => ({ score: REPUTABILITY_DEFAULT }));
  const sourceAuthority = Math.max(0.05, Math.min(1, sourceRep.score));

  const out: FrontierCandidate[] = [];
  const seen = new Set<string>();
  for (const link of input.links) {
    if (out.length >= MAX_PER_TYPE_PER_CYCLE) break;
    const c = canonicalizeUrl(link.url);
    if (!c) continue;
    if (isObviousReject(c)) continue;
    if (seen.has(c.canonical)) continue;
    seen.add(c.canonical);

    const reason = classifyReason({ link, canonical: c.canonical, host: c.host, sourceHost });
    if (!reason) continue;

    const novelty = await noveltyScore(env, c.canonical);
    const priority = Math.round(REASON_WEIGHTS[reason] * sourceAuthority * novelty * 10000) / 10000;
    out.push({
      url: c.url,
      url_canonical: c.canonical,
      host: c.host,
      profile_type_id: input.profileTypeId ?? null,
      discovery_reason: reason,
      priority,
      source_url: srcCanon.url,
      source_authority: sourceAuthority,
      novelty_score: novelty,
    });
  }

  // Email-domain mentions become low-priority candidates pointing at the
  // root of the mentioned domain (no path component — the crawler will
  // discover real pages from there).
  for (const email of input.emails ?? []) {
    if (out.length >= MAX_PER_TYPE_PER_CYCLE) break;
    const at = email.indexOf("@");
    if (at < 0) continue;
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!domain || /^(gmail|yahoo|hotmail|outlook|protonmail|icloud|aol)\.(com|net|org)$/i.test(domain)) continue;
    const c = canonicalizeUrl("https://" + domain + "/");
    if (!c) continue;
    if (seen.has(c.canonical)) continue;
    seen.add(c.canonical);
    const novelty = await noveltyScore(env, c.canonical);
    const priority = Math.round(REASON_WEIGHTS.mentioned_email_domain * sourceAuthority * novelty * 10000) / 10000;
    out.push({
      url: c.url,
      url_canonical: c.canonical,
      host: c.host,
      profile_type_id: input.profileTypeId ?? null,
      discovery_reason: "mentioned_email_domain",
      priority,
      source_url: srcCanon.url,
      source_authority: sourceAuthority,
      novelty_score: novelty,
    });
  }

  return out;
}

// expandFrontier — buildCandidates + persist. Returns the number of rows
// inserted (existing canonical URLs for the same profile_type are left
// alone via the UNIQUE constraint; re-discovery counts as 0 inserted).
export async function expandFrontier(env: Env, input: ExpandInput): Promise<{ inserted: number; candidates: FrontierCandidate[] }> {
  const candidates = await buildCandidates(env, input);
  if (candidates.length === 0) return { inserted: 0, candidates };
  let inserted = 0;
  for (const c of candidates) {
    try {
      const r = await env.DB.prepare(
        `INSERT INTO smart_frontier (id, url, url_canonical, host, profile_type_id, discovery_reason,
                                     priority, source_url, source_authority, novelty_score, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
         ON CONFLICT(profile_type_id, url_canonical) DO UPDATE SET
           priority         = MAX(smart_frontier.priority, excluded.priority),
           source_authority = excluded.source_authority,
           novelty_score    = excluded.novelty_score,
           discovered_at    = CURRENT_TIMESTAMP`,
      ).bind(
        crypto.randomUUID(), c.url, c.url_canonical, c.host, c.profile_type_id,
        c.discovery_reason, c.priority, c.source_url, c.source_authority, c.novelty_score,
      ).run();
      if (r?.meta?.changes && r.meta.changes > 0) inserted++;
    } catch (e) {
      console.warn("expandFrontier insert failed", c.url_canonical, (e as Error).message);
    }
  }
  return { inserted, candidates };
}
