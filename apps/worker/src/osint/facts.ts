// Pull the bare minimum of what we know about an entity to drive pivots.
// We read from u_entities/channels/facts (Task 4 unified schema) and
// fall back to legacy leads where needed. Everything is best-effort —
// the caller works with whatever subset we can fill.

import type { Env } from "../types";
import { parseProfileUrl, type PlatformSlug } from "./platforms";
import type { KnownEntityFacts } from "./types";

interface ChannelRow { kind: string; canonical: string; display: string | null }
interface FactRow { predicate: string; value_text: string | null }

export async function loadKnownFacts(env: Env, entityId: string): Promise<KnownEntityFacts> {
  const out: KnownEntityFacts = {
    entityId,
    displayName: null,
    emails: [],
    knownHandles: [],
    walletAddresses: [],
    personalSites: [],
  };

  // 1. Entity + display name.
  try {
    const ent = await env.DB.prepare(
      `SELECT display_name, primary_url, primary_email_key,
              primary_linkedin_key, primary_twitter_handle, primary_github_handle
         FROM u_entities WHERE id = ?`,
    ).bind(entityId).first<{
      display_name: string | null;
      primary_url: string | null;
      primary_email_key: string | null;
      primary_linkedin_key: string | null;
      primary_twitter_handle: string | null;
      primary_github_handle: string | null;
    }>();
    if (ent) {
      out.displayName = ent.display_name;
      if (ent.primary_email_key) out.emails.push(ent.primary_email_key);
      if (ent.primary_linkedin_key) out.knownHandles.push({ platform: "linkedin", handle: ent.primary_linkedin_key, url: `https://www.linkedin.com/in/${ent.primary_linkedin_key}` });
      if (ent.primary_twitter_handle) out.knownHandles.push({ platform: "twitter", handle: ent.primary_twitter_handle, url: `https://x.com/${ent.primary_twitter_handle}` });
      if (ent.primary_github_handle)  out.knownHandles.push({ platform: "github",  handle: ent.primary_github_handle,  url: `https://github.com/${ent.primary_github_handle}` });
      if (ent.primary_url) out.personalSites.push(ent.primary_url);
    }
  } catch { /* ignore — table may not exist in some envs */ }

  // 2. Channels — emails / personal URLs / extra socials.
  try {
    const ch = await env.DB.prepare(
      `SELECT kind, canonical, display FROM channels WHERE entity_id = ? AND is_dnc = 0`,
    ).bind(entityId).all<ChannelRow>();
    for (const c of ch.results ?? []) {
      if (c.kind === "email" && c.canonical) {
        const e = c.canonical.toLowerCase();
        if (!out.emails.includes(e)) out.emails.push(e);
      } else if (c.kind === "website" && c.canonical) {
        if (!out.personalSites.includes(c.canonical)) out.personalSites.push(c.canonical);
      } else if (c.kind === "linkedin" || c.kind === "twitter" || c.kind === "github") {
        const parsed = parseProfileUrl(c.canonical) ?? (c.display ? { platform: c.kind as PlatformSlug, handle: c.display } : null);
        if (parsed && !out.knownHandles.some((h) => h.platform === parsed.platform && h.handle === parsed.handle)) {
          out.knownHandles.push({ platform: parsed.platform, handle: parsed.handle, url: c.canonical });
        }
      }
    }
  } catch { /* ignore */ }

  // 3. Already-linked identity_handles (active + verified) — feed back into
  //    pivots so we don't re-probe what we already know.
  try {
    const ih = await env.DB.prepare(
      `SELECT platform, handle, url FROM identity_handles
        WHERE entity_id = ? AND is_active = 1`,
    ).bind(entityId).all<{ platform: string; handle: string; url: string | null }>();
    for (const r of ih.results ?? []) {
      if (!out.knownHandles.some((h) => h.platform === r.platform && h.handle === r.handle)) {
        out.knownHandles.push({ platform: r.platform as PlatformSlug, handle: r.handle, url: r.url });
      }
    }
  } catch { /* ignore */ }

  // 4. Facts — wallet addresses, alt URLs.
  try {
    const facts = await env.DB.prepare(
      `SELECT predicate, value_text FROM facts
        WHERE entity_id = ? AND predicate IN ('wallet_address','ens_name','personal_url','website')`,
    ).bind(entityId).all<FactRow>();
    for (const f of facts.results ?? []) {
      if (!f.value_text) continue;
      if (f.predicate === "wallet_address" || f.predicate === "ens_name") {
        if (!out.walletAddresses.includes(f.value_text)) out.walletAddresses.push(f.value_text);
      } else if (!out.personalSites.includes(f.value_text)) {
        out.personalSites.push(f.value_text);
      }
    }
  } catch { /* ignore */ }

  return out;
}
