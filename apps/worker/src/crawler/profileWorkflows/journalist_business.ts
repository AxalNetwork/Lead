// Task #1: journalist_business workflow.
//
// Fetches the publication's author archive, Muck Rack public profile,
// Twitter public, and a byline-history search.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, muckRackUrl, linkedinPersonUrl, twitterUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const JOURN_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    publication:      { type: "string" },
    beat:             { type: "array", items: { type: "string" } },
    muck_rack_url:    { type: "string" },
    recent_bylines:   { type: "array", items: { type: "string" } },
    contact_email:    { type: "string" },
  },
} as const;

interface JournExtract extends PersonExtract {
  publication?: string;
  beat?: string[];
  muck_rack_url?: string;
  recent_bylines?: string[];
  contact_email?: string;
}

const def: WorkflowDef = {
  id: "journalist_business.v1",
  profile_type_id: "journalist_business",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/author", "/staff", "/team"]),
    muckRackUrl(ctx),
    linkedinPersonUrl(ctx),
    twitterUrl(ctx),
  ],
  extractionSchema: JOURN_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a business / tech journalist from a publication " +
    "author page or Muck Rack profile. beat is the lowercase list of topics " +
    "they cover (e.g. 'venture_capital', 'fintech', 'biotech'). " +
    "recent_bylines is a list of recent article titles. contact_email is " +
    "their public newsroom email if disclosed. Reply strict JSON matching " +
    "the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as JournExtract;
    const out: FactCandidate[] = mapPerson(j, source, "journalist");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const str = (pred: string, v: unknown) => {
      if (typeof v === "string" && v.trim()) {
        out.push({ predicate: pred, valueText: v.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    str("journalist.publication",   j.publication);
    str("journalist.muck_rack_url", j.muck_rack_url);
    str("journalist.contact_email", j.contact_email);
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    arr("journalist.beat",           j.beat);
    arr("journalist.recent_bylines", j.recent_bylines);
    return out;
  },
};

export const journalistBusinessWorkflow = makeWorkflow(def);
