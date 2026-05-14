import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

// Read-only OSS Twitter via Nitter (no login). Returns the bio + display name
// when a twitter_url is present. Misses (suspended, gone) yield no_data.
export const twitter_oss: Provider = {
  name: "twitter_oss",
  priority: 38,
  isConfigured: () => true,
  dailyCapUsd: (env) => envFloat(env.TWITTER_OSS_DAILY_USD, 0),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    const { lead } = input;
    if (!lead.twitter_url) return emptyResult("missing_input");
    const m = lead.twitter_url.match(/twitter\.com\/([A-Za-z0-9_]+)/i) ?? lead.twitter_url.match(/x\.com\/([A-Za-z0-9_]+)/i);
    if (!m) return emptyResult("missing_input");
    const handle = m[1];
    const base = (env.NITTER_BASE ?? "https://nitter.net").replace(/\/$/, "");
    const url = `${base}/${handle}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "AIDataSignalBot/1.0" } });
      if (!r.ok) return emptyResult("error");
      const html = await r.text();
      const bio = (html.match(/<div class="profile-bio"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .slice(0, 1000);
      const name = (html.match(/<a class="profile-card-fullname"[^>]*>([^<]+)<\/a>/i)?.[1] ?? "").trim();
      const patch: LeadPatch = {};
      if (bio && !lead.bio) patch.bio = bio;
      if (name && !lead.name) patch.name = name;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: url, cost_usd: 0, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
