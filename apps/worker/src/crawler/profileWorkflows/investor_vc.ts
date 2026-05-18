// Task #1: investor_vc workflow.
//
// Source plan: firm root + /about + /team + /portfolio + /investments
// + /news. Cross-references Wikipedia. Extracts firm stages, sectors,
// geo focus, AUM, check size, current fund vintage, GP names. Promotes
// a fact to verified=1 when ≥2 of the source buckets agree.

import { makeWorkflow, sameOrigin, hostOf } from "./_shared";
import {
  FIRM_SCHEMA, type FirmExtract, mapFirm,
  wikipediaUrl, secEdgarAdvUrl, crunchbaseOrgUrl, linkedinCompanyUrl,
} from "./_commonSchemas";
import type { WorkflowDef } from "./_types";

const def: WorkflowDef = {
  id: "investor_vc.v1",
  profile_type_id: "investor_vc",
  estimated_cost_per_run: { sources: 9, ai_neurons: 0.9 },
  // Concrete public-source plan (task spec Step 3): firm origin pages
  // for portfolio / team / news + four cross-reference sources
  // (Wikipedia entity, SEC EDGAR ADV adviser-search, Crunchbase
  // organization, LinkedIn public company page). Each lands in its
  // own sourceTag bucket so crossRef can promote multi-source facts.
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/investments", "/news"]),
    wikipediaUrl(ctx),
    secEdgarAdvUrl(ctx),
    crunchbaseOrgUrl(ctx),
    linkedinCompanyUrl(ctx),
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
