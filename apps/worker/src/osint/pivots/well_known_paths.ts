// well-known-paths pivot.
//
// Probes a known personal-site for /.well-known/openid-configuration,
// /.well-known/webfinger, /.well-known/host-meta, and the homepage for
// rel=me / rel=author / openid_provider link tags. These conventions are
// rare enough that any positive hit is high-confidence — operators use
// well-known to bind a domain to a federated identity.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGet, pastDeadline, parallelMap } from "./_util";
import { parseProfileUrl } from "../platforms";

export async function runWellKnownPaths(_env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (!facts.personalSites.length) return [];
  if (pastDeadline(ctx.deadlineMs)) return [];

  const hits: PivotHit[] = [];
  await parallelMap(facts.personalSites.slice(0, 3), 3, async (site) => {
    let origin: string;
    try {
      const u = new URL(site.startsWith("http") ? site : `https://${site}`);
      origin = `${u.protocol}//${u.host}`;
    } catch { return; }

    // 1) WebFinger acct: discovery for primary email
    for (const email of facts.emails.slice(0, 2)) {
      if (pastDeadline(ctx.deadlineMs)) return;
      const wf = await simpleGet(`${origin}/.well-known/webfinger?resource=acct:${encodeURIComponent(email)}`, { timeoutMs: 3000, accept: "application/jrd+json" });
      if (wf.ok && wf.text) {
        try {
          const data = JSON.parse(wf.text) as { links?: Array<{ rel?: string; href?: string; type?: string }> };
          for (const l of data.links ?? []) {
            if (!l.href) continue;
            const parsed = parseProfileUrl(l.href);
            if (parsed) {
              hits.push({
                platform: parsed.platform,
                handle: parsed.handle,
                url: l.href,
                link_method: "well_known",
                base_confidence: 0.92,
                evidence_json: { source: "webfinger", origin, email, rel: l.rel },
              });
            }
          }
        } catch { /* not JSON */ }
      }
    }

    // 2) Homepage rel=me / rel=author scan
    if (pastDeadline(ctx.deadlineMs)) return;
    const home = await simpleGet(origin, { timeoutMs: 4000 });
    if (home.ok && home.text) {
      const relMeRe = /<(?:a|link)\b[^>]*\brel=["']?(?:me|author)["']?[^>]*\bhref=["']([^"']+)["']/gi;
      const hrefRe2 = /<(?:a|link)\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']?(?:me|author)["']?/gi;
      const seen = new Set<string>();
      const collect = (re: RegExp) => {
        let m: RegExpExecArray | null;
        while ((m = re.exec(home.text)) !== null) {
          const href = m[1];
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const parsed = parseProfileUrl(href);
          if (parsed) {
            hits.push({
              platform: parsed.platform,
              handle: parsed.handle,
              url: href,
              link_method: "well_known",
              base_confidence: 0.90,
              evidence_json: { source: "rel_me_on_personal_site", origin },
            });
          }
        }
      };
      collect(relMeRe);
      collect(hrefRe2);
    }
  });

  return hits;
}
