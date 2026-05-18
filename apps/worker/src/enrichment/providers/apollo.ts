// Task #5: deprecated. Apollo paid API was removed from the worker. The
// shim keeps the Provider shape so any leftover import still typechecks
// but always returns `missing_key`. ALL_PROVIDERS no longer references it.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const apollo: Provider = {
  name: "apollo",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
