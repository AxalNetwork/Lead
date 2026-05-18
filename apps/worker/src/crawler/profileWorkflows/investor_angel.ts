// Task #1: investor_angel workflow. Person-shaped (an individual angel
// rather than a firm) — fetches the candidate page, the person's
// LinkedIn / Twitter / AngelList public pages where linkable, and a
// search bootstrap.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const ANGEL_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    typical_check_min_usd: { type: "number" },
    typical_check_max_usd: { type: "number" },
    sectors:               { type: "array", items: { type: "string" } },
    portfolio_count:       { type: "number" },
    syndicate_handle:      { type: "string" },
  },
} as const;

interface AngelExtract extends PersonExtract {
  typical_check_min_usd?: number;
  typical_check_max_usd?: number;
  sectors?: string[];
  portfolio_count?: number;
  syndicate_handle?: string;
}

const def: WorkflowDef = {
  id: "investor_angel.v1",
  profile_type_id: "investor_angel",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/portfolio"]),
    ...searchUrls(namedQuery(ctx, "angel investor portfolio")).slice(0, 2),
  ],
  extractionSchema: ANGEL_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about an angel investor from a personal bio, portfolio " +
    "listing, or syndicate page. Output their full name, current day-job " +
    "title + employer, typical check sizes in USD, focus sectors, and " +
    "syndicate handle if any. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as AngelExtract;
    const out: FactCandidate[] = mapPerson(j, source, "angel");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    if (typeof j.typical_check_min_usd === "number") {
      out.push({ predicate: "angel.typical_check_min_usd", valueNumber: j.typical_check_min_usd, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.typical_check_max_usd === "number") {
      out.push({ predicate: "angel.typical_check_max_usd", valueNumber: j.typical_check_max_usd, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (Array.isArray(j.sectors)) {
      const s = j.sectors.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
      if (s.length) out.push({ predicate: "angel.sectors", valueJson: s, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.portfolio_count === "number") {
      out.push({ predicate: "angel.portfolio_count", valueNumber: j.portfolio_count, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.syndicate_handle === "string" && j.syndicate_handle.trim()) {
      out.push({ predicate: "angel.syndicate_handle", valueText: j.syndicate_handle.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    return out;
  },
};

export const investorAngelWorkflow = makeWorkflow(def);
