// Task #5: deprecated. See apollo.ts header for context.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const rocketreach: Provider = {
  name: "rocketreach",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
