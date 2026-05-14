import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface WhoisResp {
  WhoisRecord?: {
    registryData?: { registrant?: { country?: string; countryCode?: string; city?: string } };
    registrant?: { country?: string; countryCode?: string; city?: string };
  };
}

export const whoisxml: Provider = {
  name: "whoisxml",
  priority: 35,
  isConfigured: (env) => !!env.WHOISXML_API_KEY,
  dailyCapUsd: (env) => envFloat(env.WHOISXML_DAILY_USD, 1),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.WHOISXML_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    const domain = lead.source_domain ?? (lead.email?.split("@")[1] ?? null);
    if (!domain) return emptyResult("missing_input");
    try {
      const r = await fetch(
        `https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${env.WHOISXML_API_KEY}&domainName=${encodeURIComponent(domain)}&outputFormat=JSON`,
      );
      if (!r.ok) return emptyResult("error");
      const j = (await r.json()) as WhoisResp;
      const reg = j.WhoisRecord?.registrant ?? j.WhoisRecord?.registryData?.registrant;
      if (!reg) return { patch: {}, evidence_url: null, cost_usd: 0.001, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      const iso = reg.countryCode ?? reg.country?.slice(0, 2);
      if (iso && !lead.country_iso2) patch.country_iso2 = iso.toUpperCase();
      if (reg.city && !lead.city) patch.city = reg.city;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: `https://www.whoisxmlapi.com/whois/${domain}`, cost_usd: 0.001, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
