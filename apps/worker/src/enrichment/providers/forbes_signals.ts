import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

// Light-weight Forbes signal lift: we *do not* scrape Midas/Billionaire lists
// here (those go through the scraper-engine's parser). This provider just
// turns a known Forbes profile URL stored in personal_url into a net-worth-band
// hint by reading the og:description meta. If FORBES_SIGNALS_KEY is set and the
// caller wired up a private mirror, it could be used here too.
export const forbes_signals: Provider = {
  name: "forbes_signals",
  priority: 40,
  isConfigured: () => true,
  dailyCapUsd: (env) => envFloat(env.FORBES_SIGNALS_DAILY_USD, 1),
  async enrich(_env: Env, input: EnrichInput): Promise<EnrichResult> {
    const { lead } = input;
    const url = lead.personal_url && lead.personal_url.includes("forbes.com/profile")
      ? lead.personal_url
      : null;
    if (!url) return emptyResult("missing_input");
    try {
      const r = await fetch(url, { headers: { "User-Agent": "AIDataSignalBot/1.0" } });
      if (!r.ok) return emptyResult("error");
      const html = await r.text();
      const m = html.match(/(\$[\d.]+\s*(?:B|M))/i);
      const patch: LeadPatch = {};
      if (m && !lead.net_worth_band) patch.net_worth_band = m[1].toUpperCase();
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: url, cost_usd: 0, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
