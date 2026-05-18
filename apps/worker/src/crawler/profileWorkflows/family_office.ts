// Task #1: family_office workflow. Firm shape + family_principal name.

import { makeWorkflow, sameOrigin } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, wikipediaUrl, secEdgarAdvUrl, linkedinCompanyUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const FO_SCHEMA = {
  ...FIRM_SCHEMA,
  properties: { ...FIRM_SCHEMA.properties, family_principal: { type: "string" } },
} as const;

interface FoExtract extends FirmExtract { family_principal?: string }

const def: WorkflowDef = {
  id: "family_office.v1",
  profile_type_id: "family_office",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/family-office", "/investments"]),
    wikipediaUrl(ctx),
    secEdgarAdvUrl(ctx),
    linkedinCompanyUrl(ctx),
  ],
  extractionSchema: FO_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a family office. family_principal is the named " +
    "family or principal individual the office serves (e.g. 'Pritzker', " +
    "'Walton'). AUM in USD. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as FoExtract;
    const out: FactCandidate[] = mapFirm(j, source);
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    if (typeof j.family_principal === "string" && j.family_principal.trim()) {
      out.push({ predicate: "firm.family_principal", valueText: j.family_principal.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const familyOfficeWorkflow = makeWorkflow(def);
