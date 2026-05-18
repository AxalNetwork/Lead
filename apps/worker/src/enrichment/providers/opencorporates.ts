// Task #5: deprecated. Paid OpenCorporates API key path removed. The
// openCorporates SiteAdapter parses public company pages via the in-house
// fetcher when ingestion lands on opencorporates.com URLs.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const opencorporates: Provider = {
  name: "opencorporates",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
