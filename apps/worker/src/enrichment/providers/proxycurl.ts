import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface PcExperience { company: string; title: string; starts_at?: { year?: number }; ends_at?: { year?: number } }
interface PcProfile {
  full_name?: string;
  occupation?: string;
  headline?: string;
  summary?: string;
  country?: string;
  country_full_name?: string;
  city?: string;
  state?: string;
  experiences?: PcExperience[];
  personal_emails?: string[];
  personal_numbers?: string[];
  twitter_profile_url?: string;
  github_profile_url?: string;
}

export const proxycurl: Provider = {
  name: "proxycurl",
  priority: 68,
  isConfigured: (env) => !!env.PROXYCURL_API_KEY,
  dailyCapUsd: (env) => envFloat(env.PROXYCURL_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.PROXYCURL_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    if (!lead.linkedin_url) return emptyResult("missing_input");
    try {
      const url = `https://nubela.co/proxycurl/api/v2/linkedin?url=${encodeURIComponent(lead.linkedin_url)}&personal_email=include&personal_contact_number=include`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${env.PROXYCURL_API_KEY}` } });
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.04, ok: false, reason: "error" };
      const p = (await r.json()) as PcProfile;
      const patch: LeadPatch = {};
      if (p.full_name && !lead.name) patch.name = p.full_name;
      if (p.occupation && !lead.title) patch.title = p.occupation;
      if (p.summary && !lead.bio) patch.bio = p.summary;
      else if (p.headline && !lead.bio) patch.bio = p.headline;
      if (p.country && !lead.country_iso2) patch.country_iso2 = p.country.slice(0, 2).toUpperCase();
      if (p.state && !lead.region) patch.region = p.state;
      if (p.city && !lead.city) patch.city = p.city;
      if (p.personal_emails?.length && !lead.email) patch.email = p.personal_emails[0];
      if (p.personal_numbers?.length && !lead.phone) patch.phone = p.personal_numbers[0];
      if (p.twitter_profile_url && !lead.twitter_url) patch.twitter_url = p.twitter_profile_url;
      if (p.github_profile_url && !lead.github_url) patch.github_url = p.github_profile_url;
      if (p.experiences?.length) {
        patch.companies_json = JSON.stringify(
          p.experiences.slice(0, 10).map((e) => ({ company: e.company, title: e.title, from: e.starts_at?.year, to: e.ends_at?.year })),
        );
        if (!lead.org && p.experiences[0]?.company) patch.org = p.experiences[0].company;
      }
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: lead.linkedin_url, cost_usd: 0.04, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
