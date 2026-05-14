import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface PdlResp {
  status: number;
  data?: {
    work_email?: string;
    personal_emails?: string[];
    mobile_phone?: string;
    linkedin_url?: string;
    twitter_url?: string;
    github_url?: string;
    job_title?: string;
    job_title_levels?: string[];
    job_company_name?: string;
    location_country?: string;
    location_locality?: string;
    location_region?: string;
    summary?: string;
    languages?: Array<{ name: string }>;
    inferred_years_experience?: number;
  };
}

export const peopledatalabs: Provider = {
  name: "peopledatalabs",
  priority: 60,
  isConfigured: (env) => !!env.PEOPLEDATALABS_API_KEY,
  dailyCapUsd: (env) => envFloat(env.PEOPLEDATALABS_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.PEOPLEDATALABS_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    const params = new URLSearchParams({ api_key: env.PEOPLEDATALABS_API_KEY });
    if (lead.email) params.set("email", lead.email);
    else if (lead.linkedin_url) params.set("profile", lead.linkedin_url);
    else if (lead.name && lead.org) {
      params.set("name", lead.name);
      params.set("company", lead.org);
    } else return emptyResult("missing_input");
    try {
      const r = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`);
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.03, ok: false, reason: "error" };
      const j = (await r.json()) as PdlResp;
      const d = j.data;
      if (!d) return { patch: {}, evidence_url: null, cost_usd: 0.01, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      if (d.work_email && !lead.email) patch.email = d.work_email;
      if (d.personal_emails?.length && !lead.alt_emails_json) patch.alt_emails_json = JSON.stringify(d.personal_emails);
      if (d.mobile_phone && !lead.phone) patch.phone = d.mobile_phone;
      if (d.linkedin_url && !lead.linkedin_url) patch.linkedin_url = d.linkedin_url;
      if (d.twitter_url && !lead.twitter_url) patch.twitter_url = d.twitter_url;
      if (d.github_url && !lead.github_url) patch.github_url = d.github_url;
      if (d.job_title && !lead.title) patch.title = d.job_title;
      if (d.job_title_levels?.length && !lead.seniority) patch.seniority = d.job_title_levels[0];
      if (d.job_company_name && !lead.org) patch.org = d.job_company_name;
      if (d.location_country && !lead.country_iso2) patch.country_iso2 = d.location_country.slice(0, 2).toUpperCase();
      if (d.location_region && !lead.region) patch.region = d.location_region;
      if (d.location_locality && !lead.city) patch.city = d.location_locality;
      if (d.summary && !lead.bio) patch.bio = d.summary;
      if (d.languages?.length && !lead.languages_json) patch.languages_json = JSON.stringify(d.languages.map((l) => l.name));
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: "https://www.peopledatalabs.com/", cost_usd: 0.03, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
