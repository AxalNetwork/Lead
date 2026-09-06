import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface SecHit { _id: string; _source: { display_names?: string[]; form?: string; adsh?: string } }
interface SecResp { hits?: { hits?: SecHit[] } }

// Free, but rate-limited. We mostly use it to confirm a registered investment
// adviser link and lift AUM signals when present in the filing snippet.
export const sec_edgar: Provider = {
  name: "sec_edgar",
  priority: 50,
  isFree: true,
  isConfigured: () => true,
  dailyCapUsd: (env) => envFloat(env.SEC_EDGAR_DAILY_USD, 0),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    const { lead } = input;
    if (!lead.org) return emptyResult("missing_input");
    try {
      const ua = env.SEC_EDGAR_UA ?? "AIDataSignal/1.0 contact@aidatasignal.com";
      const r = await fetch(
        `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(lead.org)}%22&forms=ADV`,
        { headers: { "User-Agent": ua, Accept: "application/json" } },
      );
      if (!r.ok) return emptyResult("error");
      const j = (await r.json()) as SecResp;
      const hit = j.hits?.hits?.[0];
      if (!hit) return { patch: {}, evidence_url: null, cost_usd: 0, ok: false, reason: "no_data" };
      const patch: LeadPatch = {};
      // SEC ADV implies the firm is US-registered; tag country if absent.
      if (!lead.country_iso2) patch.country_iso2 = "US";
      const evidence = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(hit._id)}`;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: evidence, cost_usd: 0, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
