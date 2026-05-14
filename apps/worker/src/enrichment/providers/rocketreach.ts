import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface RRProfile {
  emails?: Array<{ email: string; type?: string }>;
  phones?: Array<{ number: string }>;
  links?: { linkedin?: string; twitter?: string; github?: string };
  current_title?: string;
  current_employer?: string;
  city?: string;
  region?: string;
  country?: string;
}

export const rocketreach: Provider = {
  name: "rocketreach",
  priority: 65,
  isConfigured: (env) => !!env.ROCKETREACH_API_KEY,
  dailyCapUsd: (env) => envFloat(env.ROCKETREACH_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.ROCKETREACH_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    const params = new URLSearchParams();
    if (lead.linkedin_url) params.set("li_url", lead.linkedin_url);
    else if (lead.name && lead.org) {
      params.set("name", lead.name);
      params.set("current_employer", lead.org);
    } else return emptyResult("missing_input");
    try {
      const r = await fetch(`https://api.rocketreach.co/v2/api/lookupProfile?${params}`, {
        headers: { "Api-Key": env.ROCKETREACH_API_KEY, Accept: "application/json" },
      });
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.03, ok: false, reason: "error" };
      const p = (await r.json()) as RRProfile;
      const patch: LeadPatch = {};
      const email = p.emails?.find((e) => e.type === "professional")?.email ?? p.emails?.[0]?.email;
      if (email && !lead.email) patch.email = email;
      if (p.phones?.[0]?.number && !lead.phone) patch.phone = p.phones[0].number;
      if (p.links?.linkedin && !lead.linkedin_url) patch.linkedin_url = p.links.linkedin;
      if (p.links?.twitter && !lead.twitter_url) patch.twitter_url = p.links.twitter;
      if (p.links?.github && !lead.github_url) patch.github_url = p.links.github;
      if (p.current_title && !lead.title) patch.title = p.current_title;
      if (p.current_employer && !lead.org) patch.org = p.current_employer;
      if (p.city && !lead.city) patch.city = p.city;
      if (p.region && !lead.region) patch.region = p.region;
      if (p.country && !lead.country_iso2) patch.country_iso2 = p.country.slice(0, 2).toUpperCase();
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: "https://rocketreach.co/", cost_usd: 0.03, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
