// Task #1: politician_federal workflow.
//
// Fetches congress.gov member page, FEC donor lookup, bills sponsored,
// committee memberships, and Wikipedia. Free official endpoints only.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const POL_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    chamber:                 { type: "string" }, // 'house' | 'senate'
    party:                   { type: "string" },
    state:                   { type: "string" },
    district:                { type: "string" },
    committees:              { type: "array", items: { type: "string" } },
    terms_served:            { type: "number" },
    notable_bills_sponsored: { type: "array", items: { type: "string" } },
  },
} as const;

interface PolExtract extends PersonExtract {
  chamber?: string;
  party?: string;
  state?: string;
  district?: string;
  committees?: string[];
  terms_served?: number;
  notable_bills_sponsored?: string[];
}

const def: WorkflowDef = {
  id: "politician_federal.v1",
  profile_type_id: "politician_federal",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/biography"]),
    ...searchUrls(namedQuery(ctx, "site:congress.gov member")).slice(0, 1),
    ...searchUrls(namedQuery(ctx, "site:en.wikipedia.org")).slice(0, 1),
  ],
  extractionSchema: POL_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a US federal elected official from congress.gov, " +
    "their official site, or Wikipedia. chamber is 'house' or 'senate'. " +
    "state is the two-letter US state code. district is the numeric House " +
    "district (omit for senators). committees is the list of committees " +
    "they sit on. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as PolExtract;
    const out: FactCandidate[] = mapPerson(j, source, "politician");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const str = (pred: string, v: unknown) => {
      if (typeof v === "string" && v.trim()) {
        out.push({ predicate: pred, valueText: v.trim().toLowerCase(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    str("politician.chamber",  j.chamber);
    str("politician.party",    j.party);
    str("politician.state",    j.state);
    str("politician.district", j.district);
    if (Array.isArray(j.committees)) {
      const n = j.committees.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
      if (n.length) out.push({ predicate: "politician.committees", valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.terms_served === "number") {
      out.push({ predicate: "politician.terms_served", valueNumber: j.terms_served, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (Array.isArray(j.notable_bills_sponsored)) {
      const n = j.notable_bills_sponsored.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
      if (n.length) out.push({ predicate: "politician.notable_bills_sponsored", valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const politicianFederalWorkflow = makeWorkflow(def);
