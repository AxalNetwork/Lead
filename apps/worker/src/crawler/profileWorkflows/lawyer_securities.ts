// Task #1: lawyer_securities workflow.
//
// Fetches attorney bio on law-firm site, state bar profile, and a
// Martindale / SEC filings search bootstrap. Extracts bar admissions,
// JD school, notable engagements, practice areas.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, martindaleUrl, courtListenerUrl, linkedinPersonUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const LAW_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    bar_admissions:  { type: "array", items: { type: "string" } }, // ISO state/country codes
    practice_areas:  { type: "array", items: { type: "string" } },
    jd_school:       { type: "string" },
    notable_engagements: { type: "array", items: { type: "string" } },
  },
} as const;

interface LawExtract extends PersonExtract {
  bar_admissions?: string[];
  practice_areas?: string[];
  jd_school?: string;
  notable_engagements?: string[];
}

const def: WorkflowDef = {
  id: "lawyer_securities.v1",
  profile_type_id: "lawyer_securities",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/professionals", "/people"]),
    martindaleUrl(ctx),
    courtListenerUrl(ctx),
    linkedinPersonUrl(ctx),
  ],
  extractionSchema: LAW_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a securities / corporate attorney from a law-firm " +
    "bio or state-bar profile. bar_admissions is a list of jurisdictions " +
    "(US-state ISO codes or country names). practice_areas are lowercase " +
    "tags (e.g. 'securities', 'm&a', 'venture financings', 'ipo'). " +
    "notable_engagements names public deals or filings the attorney was " +
    "counsel of record on. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as LawExtract;
    const out: FactCandidate[] = mapPerson(j, source, "lawyer");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    arr("lawyer.bar_admissions",      j.bar_admissions);
    arr("lawyer.practice_areas",      j.practice_areas);
    arr("lawyer.notable_engagements", j.notable_engagements);
    if (typeof j.jd_school === "string" && j.jd_school.trim()) {
      out.push({ predicate: "lawyer.jd_school", valueText: j.jd_school.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const lawyerSecuritiesWorkflow = makeWorkflow(def);
