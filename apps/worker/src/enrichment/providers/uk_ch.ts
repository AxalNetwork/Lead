// Task #5: deprecated. UK Companies House key-gated API removed. Public
// company pages are reachable via the in-house fetcher + companiesHouseUK
// SiteAdapter.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const uk_ch: Provider = {
  name: "uk_ch",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
