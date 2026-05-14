import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface OcResp {
  results?: { companies?: Array<{ company: { name: string; jurisdiction_code: string; opencorporates_url: string } }> };
}

export const opencorporates: Provider = {
  name: "opencorporates",
  priority: 45,
  isConfigured: () => true, // anonymous queries allowed (rate-limited)
  dailyCapUsd: (env) => envFloat(env.OPENCORPORATES_DAILY_USD, 2),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    const { lead } = input;
    if (!lead.org) return emptyResult("missing_input");
    try {
      const key = env.OPENCORPORATES_API_KEY ? `&api_token=${env.OPENCORPORATES_API_KEY}` : "";
      const r = await fetch(`https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(lead.org)}${key}`);
      if (!r.ok) return emptyResult("error");
      const j = (await r.json()) as OcResp;
      const c = j.results?.companies?.[0]?.company;
      if (!c) return { patch: {}, evidence_url: null, cost_usd: 0, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      const iso = c.jurisdiction_code?.split("_")[0]?.toUpperCase();
      if (iso && !lead.country_iso2) patch.country_iso2 = iso;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: c.opencorporates_url, cost_usd: 0.001, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
