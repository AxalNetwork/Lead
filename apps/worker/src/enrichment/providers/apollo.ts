import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface ApolloPerson {
  person?: {
    email?: string;
    title?: string;
    linkedin_url?: string;
    twitter_url?: string;
    github_url?: string;
    city?: string;
    state?: string;
    country?: string;
    headline?: string;
    seniority?: string;
    departments?: string[];
    organization?: { name?: string; estimated_num_employees?: number };
  };
}

export const apollo: Provider = {
  name: "apollo",
  priority: 75,
  isConfigured: (env) => !!env.APOLLO_API_KEY,
  dailyCapUsd: (env) => envFloat(env.APOLLO_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.APOLLO_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    const body: Record<string, unknown> = {};
    if (lead.email) body.email = lead.email;
    if (lead.name) {
      const [first, ...rest] = lead.name.split(/\s+/);
      body.first_name = first;
      body.last_name = rest.join(" ");
    }
    if (lead.org) body.organization_name = lead.org;
    if (lead.linkedin_url) body.linkedin_url = lead.linkedin_url;
    if (Object.keys(body).length === 0) return emptyResult("missing_input");
    try {
      const r = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY },
        body: JSON.stringify(body),
      });
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.02, ok: false, reason: "error" };
      const j = (await r.json()) as ApolloPerson;
      const p = j.person;
      if (!p) return { patch: {}, evidence_url: null, cost_usd: 0.01, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      if (p.email && !lead.email) patch.email = p.email;
      if (p.title && !lead.title) patch.title = p.title;
      if (p.linkedin_url && !lead.linkedin_url) patch.linkedin_url = p.linkedin_url;
      if (p.twitter_url && !lead.twitter_url) patch.twitter_url = p.twitter_url;
      if (p.github_url && !lead.github_url) patch.github_url = p.github_url;
      if (p.city && !lead.city) patch.city = p.city;
      if (p.state && !lead.region) patch.region = p.state;
      if (p.country && !lead.country_iso2) patch.country_iso2 = p.country.slice(0, 2).toUpperCase();
      if (p.headline && !lead.bio) patch.bio = p.headline;
      if (p.seniority && !lead.seniority) patch.seniority = p.seniority;
      if (p.departments && p.departments.length && !lead.function_area) patch.function_area = p.departments[0];
      if (p.organization?.name && !lead.org) patch.org = p.organization.name;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: "https://app.apollo.io/", cost_usd: 0.02, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
