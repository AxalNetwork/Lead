// Venture-firm /team and /people directory adapter. Each top-tier
// firm's roster page is treated as a directory yielding multiple
// `gp_partner` candidate profiles (the registry's id for what the
// task spec calls "investor_person"). This adapter is acceptance-
// critical: hitting `firstround.com/team/` must yield multiple GPs.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { stripTags, collectLinks, safeHost, isSameRegistrableHost } from "./_util";

const VENTURE_FIRM_HOSTS = [
  // Tier-1 US firms.
  "firstround.com", "www.firstround.com",
  "a16z.com", "www.a16z.com",
  "sequoiacap.com", "www.sequoiacap.com",
  "accel.com", "www.accel.com",
  "usv.com", "www.usv.com",
  "benchmark.com", "www.benchmark.com",
  "greylock.com", "www.greylock.com",
  "kpcb.com", "www.kpcb.com",
  "ggvc.com", "www.ggvc.com",
  "indexventures.com", "www.indexventures.com",
  "lightspeed.com", "www.lightspeed.com",
  "foundersfund.com", "www.foundersfund.com",
  "khoslaventures.com", "www.khoslaventures.com",
  "menlovc.com", "www.menlovc.com",
  "nea.com", "www.nea.com",
  "bvp.com", "www.bvp.com",
  "ivp.com", "www.ivp.com",
  "redpoint.com", "www.redpoint.com",
  "matrixpartners.com", "www.matrixpartners.com",
  "founderscircle.com", "www.founderscircle.com",
];

// Words near a name on a /team page that strongly suggest a partner-
// like role. Used both to title-case slug-derived names and to detect
// inline cards on directory pages.
const ROLE_HINTS = [
  "partner", "general partner", "managing partner", "managing director",
  "principal", "vice president", "associate", "venture partner",
  "operating partner", "investor", "chief", "founder", "ceo",
];

function looksLikePersonSlug(slug: string): boolean {
  if (!slug || slug.length < 2 || slug.length > 60) return false;
  // Generic /team page noise we never want as a "person" link.
  const banned = /^(about|careers?|portfolio|news|blog|contact|home|news-?and-?press|terms|privacy|founders?|companies|investments|insights|stories|events|podcast|legal|cookies?)$/i;
  if (banned.test(slug)) return false;
  // Person slugs usually have a hyphen between first/last; allow single
  // tokens for firms that use first-name only (e.g. /team/sarah).
  return /^[a-z][a-z0-9-]*$/.test(slug);
}

function nameFromSlug(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function inferRoleFromCard(html: string, slug: string): string | null {
  // Pull a ~400-char window around the first occurrence of the slug.
  const idx = html.toLowerCase().indexOf(`/${slug.toLowerCase()}`);
  if (idx < 0) return null;
  const window = stripTags(html.slice(Math.max(0, idx - 200), idx + 400)).toLowerCase();
  for (const hint of ROLE_HINTS) {
    if (window.includes(hint)) {
      // Return the longest matching role phrase.
      return hint.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

export const venturePartnerListings: SiteAdapter = {
  id: "venture_partner_listings",
  priority: 78,
  hosts: VENTURE_FIRM_HOSTS,
  url_patterns: [
    /^\/team\/?$/i, /^\/people\/?$/i, /^\/our-team\/?$/i, /^\/the-team\/?$/i,
    /^\/team\/[^/]+$/i, /^\/people\/[^/]+$/i, /^\/our-team\/[^/]+$/i,
  ],
  profile_types_emitted: ["gp_partner", "principal", "associate", "operating_partner", "venture_partner"],
  extract(html, url): AdapterResult {
    let pathname = "/";
    try { pathname = new URL(url).pathname; } catch { /* ignore */ }
    const host = safeHost(url).replace(/^www\./, "");
    const firmName = host.split(".")[0];
    const isDirectory = /\/(team|people|our-team|the-team)\/?$/i.test(pathname);

    if (isDirectory) {
      // Collect every link of the form /team/<slug> on the same host
      // and treat each unique slug as a candidate partner. The text
      // window around the slug feeds the role hint.
      const links = collectLinks(html, url);
      const seen = new Set<string>();
      const candidates: AdapterCandidate[] = [];
      const childUrls: string[] = [];
      for (const link of links) {
        let u: URL;
        try { u = new URL(link); } catch { continue; }
        if (!isSameRegistrableHost(link, host)) continue;
        const segs = u.pathname.split("/").filter(Boolean);
        if (segs.length !== 2) continue;
        if (!/^(team|people|our-team|the-team)$/i.test(segs[0])) continue;
        const slug = segs[1];
        if (!looksLikePersonSlug(slug)) continue;
        if (seen.has(slug)) continue;
        seen.add(slug);
        const name = nameFromSlug(slug);
        const role = inferRoleFromCard(html, slug);
        candidates.push({
          profile_type: "gp_partner",
          confidence: 0.6,
          name, url: u.toString(),
          data: {
            name, role,
            firm_employer: firmName,
            firm_website: `https://${host}/`,
            source_directory: url,
          },
        });
        childUrls.push(u.toString());
      }
      return {
        adapter_id: "venture_partner_listings",
        confidence: candidates.length ? Math.min(0.85, 0.4 + candidates.length * 0.02) : 0.2,
        candidates,
        child_urls: childUrls,
        notes: { directory: true, firm: firmName, found: candidates.length },
      };
    }

    // Individual partner page.
    const slug = pathname.split("/").filter(Boolean).pop() || "";
    const name = nameFromSlug(slug);
    const text = stripTags(html);
    const role = ROLE_HINTS
      .map((h) => text.toLowerCase().includes(h) ? h.replace(/\b\w/g, (c) => c.toUpperCase()) : null)
      .filter(Boolean)[0] ?? null;
    const bio = text.slice(0, 600);
    return {
      adapter_id: "venture_partner_listings",
      confidence: name ? 0.7 : 0.3,
      candidates: [{
        profile_type: "gp_partner",
        confidence: name ? 0.7 : 0.3,
        name, url,
        data: { name, role, bio, firm_employer: firmName, firm_website: `https://${host}/`, profile_url: url },
      }],
      child_urls: [],
    };
  },
};
