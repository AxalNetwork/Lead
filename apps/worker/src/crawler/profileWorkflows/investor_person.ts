// Task #1: investor_person workflow — people-at-firm.
//
// Given a firm-team-page candidate, fetches the individual's bio on the
// firm site, LinkedIn public, Twitter public, Crunchbase person page,
// and their personal site if linked. Extracts current title, prior-role
// timeline, notable investments, board seats, podcast appearances.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const INV_PERSON_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    notable_investments: { type: "array", items: { type: "string" } },
    board_seats:         { type: "array", items: { type: "string" } },
    podcast_appearances: { type: "array", items: { type: "string" } },
    firm_role:           { type: "string" }, // partner|principal|associate|advisor
  },
} as const;

interface InvPersonExtract extends PersonExtract {
  notable_investments?: string[];
  board_seats?: string[];
  podcast_appearances?: string[];
  firm_role?: string;
}

const def: WorkflowDef = {
  id: "investor_person.v1",
  profile_type_id: "investor_person",
  estimated_cost_per_run: { sources: 5, ai_neurons: 0.5 },
  plan: (ctx) => [
    // /people/<slug> bios live on the firm site; we try the candidate's
    // sibling /about and the team-roster as cross-refs.
    ...sameOrigin(ctx.candidateUrl, ["/team", "/about"]),
    ...searchUrls(namedQuery(ctx, "investor partner linkedin")).slice(0, 1),
    ...searchUrls(namedQuery(ctx, "investor crunchbase person")).slice(0, 1),
  ],
  extractionSchema: INV_PERSON_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about an investor (VC, PE, or angel partner). firm_role " +
    "is one of {partner, principal, associate, vp, advisor, scout, eir}. " +
    "notable_investments is a list of portfolio-company names this person " +
    "led or sourced. board_seats is a list of companies whose boards they " +
    "currently sit on. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as InvPersonExtract;
    const out: FactCandidate[] = mapPerson(j, source, "person");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    arr("person.notable_investments", j.notable_investments);
    arr("person.board_seats",          j.board_seats);
    arr("person.podcast_appearances",  j.podcast_appearances);
    if (typeof j.firm_role === "string" && j.firm_role.trim()) {
      out.push({ predicate: "person.firm_role", valueText: j.firm_role.trim().toLowerCase(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const investorPersonWorkflow = makeWorkflow(def);
