// Task #1: regulator_sec workflow.
//
// Fetches the SEC.gov bio, speeches index, enforcement-action mentions,
// and congressional testimony pages. All free official endpoints.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const REG_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    sec_role:            { type: "string" }, // 'commissioner' | 'division_director' | 'enforcement_attorney' | ...
    division:            { type: "string" }, // 'corp_fin' | 'enforcement' | 'trading_markets' | 'investment_management'
    appointed_year:      { type: "number" },
    notable_enforcement: { type: "array", items: { type: "string" } },
    speeches_recent:     { type: "array", items: { type: "string" } },
  },
} as const;

interface RegExtract extends PersonExtract {
  sec_role?: string;
  division?: string;
  appointed_year?: number;
  notable_enforcement?: string[];
  speeches_recent?: string[];
}

const def: WorkflowDef = {
  id: "regulator_sec.v1",
  profile_type_id: "regulator_sec",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about/biography", "/news/speech"]),
    ...searchUrls(namedQuery(ctx, "site:sec.gov speech")).slice(0, 1),
    ...searchUrls(namedQuery(ctx, "SEC enforcement action")).slice(0, 1),
  ],
  extractionSchema: REG_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about an SEC official from sec.gov. sec_role is one of " +
    "{commissioner, division_director, deputy_director, enforcement_attorney, " +
    "general_counsel, chief_accountant}. division is the SEC division name " +
    "(corp_fin, enforcement, trading_markets, investment_management, etc.). " +
    "notable_enforcement names public cases. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as RegExtract;
    const out: FactCandidate[] = mapPerson(j, source, "regulator");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const str = (pred: string, v: unknown) => {
      if (typeof v === "string" && v.trim()) {
        out.push({ predicate: pred, valueText: v.trim().toLowerCase(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    str("regulator.sec_role", j.sec_role);
    str("regulator.division", j.division);
    if (typeof j.appointed_year === "number") {
      out.push({ predicate: "regulator.appointed_year", valueNumber: j.appointed_year, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    arr("regulator.notable_enforcement", j.notable_enforcement);
    arr("regulator.speeches_recent",     j.speeches_recent);
    return out;
  },
};

export const regulatorSecWorkflow = makeWorkflow(def);
