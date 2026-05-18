// Task #5: deprecated. Paid Crunchbase v4 API removed. The crunchbasePublic
// SiteAdapter handles public crunchbase.com pages via the in-house fetcher.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const crunchbase: Provider = {
  name: "crunchbase",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
