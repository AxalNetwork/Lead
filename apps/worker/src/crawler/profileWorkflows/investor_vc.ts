// Task #1: investor_vc workflow.
//
// Source plan: firm root + /about + /team + /portfolio + /investments
// + /news. Cross-references Wikipedia. Extracts firm stages, sectors,
// geo focus, AUM, check size, current fund vintage, GP names. Promotes
// a fact to verified=1 when ≥2 of the source buckets agree.

import { makeWorkflow, sameOrigin, hostOf } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, searchUrls, namedQuery } from "./_commonSchemas";
import type { WorkflowDef } from "./_types";

const def: WorkflowDef = {
  id: "investor_vc.v1",
  profile_type_id: "investor_vc",
  estimated_cost_per_run: { sources: 7, ai_neurons: 0.7 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/investments", "/news"]),
    ...searchUrls(namedQuery(ctx, "venture capital firm wikipedia")).slice(0, 1),
  ],
  extractionSchema: FIRM_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "You are extracting facts about a venture-capital firm from one of its " +
    "web pages (about/team/portfolio/news) or a Wikipedia entry. Return " +
    "ONLY facts you can directly cite from the page text. Stages are " +
    "from {pre_seed, seed, series_a, series_b, series_c, growth, late_stage}. " +
    "Sectors are lowercase tags. AUM and check sizes are in USD (convert " +
    "millions/billions to base USD). GP and partner names are full names " +
    "as printed on the team page. Reply strict JSON matching the schema; " +
    "omit fields you cannot infer.",
  map: ({ aiJson, source }) => {
    const j = aiJson as FirmExtract;
    return mapFirm(j, source);
  },
};

export const investorVcWorkflow = makeWorkflow(def);
export { hostOf };
