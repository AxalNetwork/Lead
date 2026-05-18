// Task #1: investor_corporate_vc workflow. Same firm shape, plus an
// extracted `corporate_parent` field that the CVC always carries.

import { makeWorkflow, sameOrigin } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const CVC_SCHEMA = {
  ...FIRM_SCHEMA,
  properties: { ...FIRM_SCHEMA.properties, corporate_parent: { type: "string" }, strategic_thesis: { type: "string" } },
} as const;

interface CvcExtract extends FirmExtract { corporate_parent?: string; strategic_thesis?: string }

const def: WorkflowDef = {
  id: "investor_corporate_vc.v1",
  profile_type_id: "investor_corporate_vc",
  estimated_cost_per_run: { sources: 6, ai_neurons: 0.6 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/news", "/ventures"]),
    ...searchUrls(namedQuery(ctx, "corporate venture capital arm wikipedia")).slice(0, 1),
  ],
  extractionSchema: CVC_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a corporate venture-capital arm. The 'corporate_parent' " +
    "field is the parent corporation that funds and houses this CVC. " +
    "'strategic_thesis' is the one-sentence description of why the parent " +
    "invests (e.g. 'pipeline of acquisition targets in fintech'). Otherwise " +
    "schema matches a VC firm. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as CvcExtract;
    const out: FactCandidate[] = mapFirm(j, source);
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    if (typeof j.corporate_parent === "string" && j.corporate_parent.trim()) {
      out.push({ predicate: "firm.corporate_parent", valueText: j.corporate_parent.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.strategic_thesis === "string" && j.strategic_thesis.trim()) {
      out.push({ predicate: "firm.strategic_thesis", valueText: j.strategic_thesis.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const investorCorporateVcWorkflow = makeWorkflow(def);
