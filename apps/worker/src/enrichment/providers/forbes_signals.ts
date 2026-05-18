// Task #5: deprecated. The forbes_signals provider previously did a
// direct HTTP fetch of forbes.com profile pages; that path is now
// routed through the in-house fetcher + adapter framework when a
// forbes.com URL lands in the ingestion pipeline.
import type { Env } from "../../types";
import { emptyResult, type EnrichInput, type EnrichResult, type Provider } from "../types";

export const forbes_signals: Provider = {
  name: "forbes_signals",
  priority: 0,
  isConfigured: (_env: Env) => false,
  dailyCapUsd: (_env: Env) => 0,
  async enrich(_env: Env, _input: EnrichInput): Promise<EnrichResult> {
    return emptyResult("missing_key");
  },
};
