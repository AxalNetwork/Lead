import type { Env } from "../../types";
import type { LeadPatch } from "../../db/leads.types";
import { emptyResult, envFloat, type EnrichInput, type EnrichResult, type Provider } from "../types";

interface HunterFinder {
  data?: { email?: string; score?: number; phone_number?: string; position?: string; linkedin?: string };
}

export const hunter: Provider = {
  name: "hunter",
  priority: 70,
  isConfigured: (env) => !!env.HUNTER_API_KEY,
  dailyCapUsd: (env) => envFloat(env.HUNTER_DAILY_USD, 5),
  async enrich(env: Env, input: EnrichInput): Promise<EnrichResult> {
    if (!env.HUNTER_API_KEY) return emptyResult("missing_key");
    const { lead } = input;
    const domain = lead.source_domain ?? (lead.email?.split("@")[1] ?? null);
    const [first, ...rest] = (lead.name ?? "").split(/\s+/);
    const last = rest.join(" ");
    if (!domain || !first || !last) return emptyResult("missing_input");
    try {
      const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${env.HUNTER_API_KEY}`;
      const r = await fetch(url);
      if (!r.ok) return { patch: {}, evidence_url: null, cost_usd: 0.005, ok: false, reason: "error" };
      const j = (await r.json()) as HunterFinder;
      const patch: LeadPatch = {};
      if (j.data?.email && !lead.email) patch.email = j.data.email;
      if (j.data?.phone_number && !lead.phone) patch.phone = j.data.phone_number;
      if (j.data?.position && !lead.title) patch.title = j.data.position;
      if (j.data?.linkedin && !lead.linkedin_url) patch.linkedin_url = j.data.linkedin;
      const ok = Object.keys(patch).length > 0;
      return { patch, evidence_url: url.replace(env.HUNTER_API_KEY, "***"), cost_usd: 0.005, ok, reason: ok ? undefined : "no_data" };
    } catch {
      return emptyResult("error");
    }
  },
};
