import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface UkResp { items?: Array<{ company_number: string; title: string; address?: { country?: string; locality?: string } }> }

export const uk_ch: Provider = {
  name: "uk_ch",
  priority: 48,
  isConfigured: (env) => !!env.UK_CH_API_KEY,
  dailyCapUsd: (env) => envFloat(env.UK_CH_DAILY_USD, 0),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.UK_CH_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    if (!lead.org) return emptyResult("missing_input");
    try {
      const r = await fetch(
        `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(lead.org)}`,
        { headers: { Authorization: "Basic " + btoa(env.UK_CH_API_KEY + ":") } },
      );
      if (!r.ok) return emptyResult("error");
      const j = (await r.json()) as UkResp;
      const it = j.items?.[0];
      if (!it) return { patch: {}, evidence_url: null, cost_usd: 0, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      if (!lead.country_iso2) patch.country_iso2 = "GB";
      if (it.address?.locality && !lead.city) patch.city = it.address.locality;
      const evidence = `https://find-and-update.company-information.service.gov.uk/company/${it.company_number}`;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: evidence, cost_usd: 0, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
