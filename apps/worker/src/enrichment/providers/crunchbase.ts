import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface CbEntity {
  entities?: Array<{
    properties?: {
      identifier?: { value?: string; permalink?: string };
      short_description?: string;
      location_identifiers?: Array<{ value?: string; location_type?: string }>;
      website?: { value?: string };
      linkedin?: { value?: string };
    };
  }>;
}

export const crunchbase: Provider = {
  name: "crunchbase",
  priority: 72,
  isConfigured: (env) => !!env.CRUNCHBASE_API_KEY,
  dailyCapUsd: (env) => envFloat(env.CRUNCHBASE_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.CRUNCHBASE_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    if (!lead.name) return emptyResult("missing_input");
    try {
      const body = {
        field_ids: ["identifier", "short_description", "location_identifiers", "website", "linkedin"],
        query: [{ type: "predicate", field_id: "identifier", operator_id: "contains", values: [lead.name] }],
        limit: 1,
      };
      const r = await fetch(`https://api.crunchbase.com/api/v4/searches/people?user_key=${env.CRUNCHBASE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.02, ok: false, reason: "error" };
      const j = (await r.json()) as CbEntity;
      const e = j.entities?.[0]?.properties;
      if (!e) return { patch: {}, evidence_url: null, cost_usd: 0.01, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      if (e.short_description && !lead.bio) patch.bio = e.short_description;
      const country = e.location_identifiers?.find((l) => l.location_type === "country")?.value;
      const city = e.location_identifiers?.find((l) => l.location_type === "city")?.value;
      if (country && !lead.country_iso2) patch.country_iso2 = country.slice(0, 2).toUpperCase();
      if (city && !lead.city) patch.city = city;
      if (e.website?.value && !lead.personal_url) patch.personal_url = e.website.value;
      if (e.linkedin?.value && !lead.linkedin_url) patch.linkedin_url = e.linkedin.value;
      const evidence = e.identifier?.permalink ? `https://www.crunchbase.com/person/${e.identifier.permalink}` : "https://www.crunchbase.com/";
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: evidence, cost_usd: 0.02, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
