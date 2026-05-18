// Task #1: fund_of_funds workflow. Firm shape + fund_count_committed
// (the number of underlying GP funds the FoF has backed).

import { makeWorkflow, sameOrigin } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, wikipediaUrl, secEdgarAdvUrl, crunchbaseOrgUrl, linkedinCompanyUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const FOF_SCHEMA = {
  ...FIRM_SCHEMA,
  properties: { ...FIRM_SCHEMA.properties, fund_count_committed: { type: "number" } },
} as const;

interface FofExtract extends FirmExtract { fund_count_committed?: number }

const def: WorkflowDef = {
  id: "fund_of_funds.v1",
  profile_type_id: "fund_of_funds",
  estimated_cost_per_run: { sources: 5, ai_neurons: 0.5 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/managers"]),
    wikipediaUrl(ctx),
    secEdgarAdvUrl(ctx),
    crunchbaseOrgUrl(ctx),
    linkedinCompanyUrl(ctx),
  ],
  extractionSchema: FOF_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a fund-of-funds. fund_count_committed is the number " +
    "of underlying GP funds this FoF has committed capital to. AUM is in USD. " +
    "Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as FofExtract;
    const out: FactCandidate[] = mapFirm(j, source);
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    if (typeof j.fund_count_committed === "number") {
      out.push({ predicate: "firm.fund_count_committed", valueNumber: j.fund_count_committed, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const fundOfFundsWorkflow = makeWorkflow(def);
