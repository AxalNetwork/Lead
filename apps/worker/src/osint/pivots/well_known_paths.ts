// well-known-paths pivot.
//
// Probes a known personal-site for /.well-known/openid-configuration,
// /.well-known/webfinger, /.well-known/host-meta, and the homepage for
// rel=me / rel=author / openid_provider link tags. These conventions are
// rare enough that any positive hit is high-confidence — operators use
// well-known to bind a domain to a federated identity.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGetCached, pastDeadline, parallelMap } from "./_util";
import { parseProfileUrl } from "../platforms";

export async function runWellKnownPaths(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
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
      const wf = await simpleGetCached(env, `${origin}/.well-known/webfinger?resource=acct:${encodeURIComponent(email)}`, { timeoutMs: 3000, accept: "application/jrd+json" });
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

    // 2) /.well-known/keybase.txt — domain → keybase username binding
    if (!pastDeadline(ctx.deadlineMs)) {
      const kb = await simpleGetCached(env, `${origin}/.well-known/keybase.txt`, { timeoutMs: 3000, accept: "text/plain" });
      if (kb.ok && kb.text) {
        const m = kb.text.match(/keybase\.io\/([a-z0-9_]+)/i);
        if (m) hits.push({
          platform: "keybase", handle: m[1].toLowerCase(),
          url: `https://keybase.io/${m[1]}`,
          link_method: "well_known", base_confidence: 0.96,
          evidence_json: { source: "keybase_txt", origin },
        });
      }
    }

    // 3) /.well-known/openid-configuration — issuer often points to a
    // canonical identity provider that includes the operator's handle
    if (!pastDeadline(ctx.deadlineMs)) {
      const oid = await simpleGetCached(env, `${origin}/.well-known/openid-configuration`, { timeoutMs: 3000, accept: "application/json" });
      if (oid.ok && oid.text) {
        try {
          const j = JSON.parse(oid.text) as { issuer?: string };
          if (j.issuer) {
            const parsed = parseProfileUrl(j.issuer);
            if (parsed) hits.push({
              platform: parsed.platform, handle: parsed.handle, url: j.issuer,
              link_method: "well_known", base_confidence: 0.90,
              evidence_json: { source: "openid_configuration", origin, issuer: j.issuer },
            });
          }
        } catch { /* not JSON */ }
      }
    }

    // 4) /.well-known/security.txt — Contact: links sometimes leak the
    // operator's email or social profile (mailto: / https://...)
    if (!pastDeadline(ctx.deadlineMs)) {
      const sec = await simpleGetCached(env, `${origin}/.well-known/security.txt`, { timeoutMs: 2500, accept: "text/plain" });
      if (sec.ok && sec.text) {
        const re = /^Contact:\s*(.+)$/gim;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sec.text)) !== null) {
          const contact = m[1].trim();
          if (contact.startsWith("http")) {
            const parsed = parseProfileUrl(contact);
            if (parsed) hits.push({
              platform: parsed.platform, handle: parsed.handle, url: contact,
              link_method: "well_known", base_confidence: 0.88,
              evidence_json: { source: "security_txt_contact", origin },
            });
          }
        }
      }
    }

    // 5) /humans.txt — TEAM section sometimes exposes Twitter:/GitHub: lines
    if (!pastDeadline(ctx.deadlineMs)) {
      const hum = await simpleGetCached(env, `${origin}/humans.txt`, { timeoutMs: 2500, accept: "text/plain" });
      if (hum.ok && hum.text) {
        const re = /^(?:Twitter|GitHub|LinkedIn|Mastodon|Site):\s*(.+)$/gim;
        let m: RegExpExecArray | null;
        while ((m = re.exec(hum.text)) !== null) {
          const v = m[1].trim();
          const cand = v.startsWith("http") ? v : (v.startsWith("@") ? `https://twitter.com/${v.slice(1)}` : v);
          const parsed = parseProfileUrl(cand);
          if (parsed) hits.push({
            platform: parsed.platform, handle: parsed.handle, url: cand,
            link_method: "well_known", base_confidence: 0.85,
            evidence_json: { source: "humans_txt", origin },
          });
        }
      }
    }

    // 6) /about.json (Jekyll/static convention) — links: { twitter, github }
    if (!pastDeadline(ctx.deadlineMs)) {
      const ab = await simpleGetCached(env, `${origin}/about.json`, { timeoutMs: 2500, accept: "application/json" });
      if (ab.ok && ab.text) {
        try {
          const j = JSON.parse(ab.text) as { links?: Record<string, string>; profiles?: Record<string, string> };
          const map = { ...(j.links ?? {}), ...(j.profiles ?? {}) };
          for (const v of Object.values(map)) {
            if (typeof v !== "string") continue;
            const parsed = parseProfileUrl(v);
            if (parsed) hits.push({
              platform: parsed.platform, handle: parsed.handle, url: v,
              link_method: "well_known", base_confidence: 0.88,
              evidence_json: { source: "about_json", origin },
            });
          }
        } catch { /* not JSON */ }
      }
    }

    // 7) Homepage rel=me / rel=author scan
    if (pastDeadline(ctx.deadlineMs)) return;
    const home = await simpleGetCached(env, origin, { timeoutMs: 4000 });
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
