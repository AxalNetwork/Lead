// Task #1: investor_pe workflow. Same firm shape as investor_vc but
// tuned for buyout / control-investment language and PE-specific
// sibling pages (/funds, /strategies).

import { makeWorkflow, sameOrigin } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, searchUrls, namedQuery } from "./_commonSchemas";
import type { WorkflowDef } from "./_types";

const def: WorkflowDef = {
  id: "investor_pe.v1",
  profile_type_id: "investor_pe",
  estimated_cost_per_run: { sources: 7, ai_neurons: 0.7 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/funds", "/strategies", "/news"]),
    ...searchUrls(namedQuery(ctx, "private equity firm wikipedia")).slice(0, 1),
  ],
  extractionSchema: FIRM_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a private-equity firm from one of its public pages " +
    "or a Wikipedia entry. Sectors are lowercase tags. AUM is in USD (convert " +
    "B/M). Stages here are typically {growth, late_stage, buyout, control}; " +
    "treat 'buyout' / 'lbo' as a stage. GP / partner names are full names. " +
    "Reply strict JSON matching the schema; omit fields you cannot infer.",
  map: ({ aiJson, source }) => mapFirm(aiJson as FirmExtract, source),
};

export const investorPeWorkflow = makeWorkflow(def);
