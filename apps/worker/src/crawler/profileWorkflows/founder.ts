// Task #1: founder workflow + variants (co_founder, founding_engineer,
// repeat_founder).
//
// All four share the founder-shaped source plan and schema; they differ
// only in profile_type_id + one additional emitted predicate so the
// router can fan a single team-page hit into per-role records.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const FOUNDER_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    company_founded:   { type: "string" },
    prior_companies:   { type: "array", items: { type: "string" } },
    co_founders:       { type: "array", items: { type: "string" } },
    raised_total_usd:  { type: "number" },
    headcount:         { type: "number" },
  },
} as const;

interface FounderExtract extends PersonExtract {
  company_founded?: string;
  prior_companies?: string[];
  co_founders?: string[];
  raised_total_usd?: number;
  headcount?: number;
}

function makeFounderDef(typeId: string, variantLabel: string): WorkflowDef {
  return {
    id: `${typeId}.v1`,
    profile_type_id: typeId,
    estimated_cost_per_run: { sources: 5, ai_neurons: 0.5 },
    plan: (ctx) => [
      ...sameOrigin(ctx.candidateUrl, ["/about", "/team"]),
      ...searchUrls(namedQuery(ctx, "founder linkedin crunchbase")).slice(0, 2),
      ...searchUrls(namedQuery(ctx, "founder github")).slice(0, 1),
    ],
    extractionSchema: FOUNDER_SCHEMA as unknown as Record<string, unknown>,
    systemPrompt:
      `Extract facts about a startup ${variantLabel} from a bio, team page, ` +
      "or Crunchbase entry. company_founded is the company they founded " +
      "(empty for non-founders). prior_companies is their previous-employer " +
      "list. co_founders is the names of others who founded the same company. " +
      "raised_total_usd is the total disclosed funding the founded company " +
      "has raised (USD). Reply strict JSON matching the schema.",
    map: ({ aiJson, source }) => {
      const j = aiJson as FounderExtract;
      const out: FactCandidate[] = mapPerson(j, source, "founder");
      const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
      if (typeof j.company_founded === "string" && j.company_founded.trim()) {
        out.push({ predicate: "founder.company_founded", valueText: j.company_founded.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
      const arr = (pred: string, v: unknown) => {
        if (Array.isArray(v)) {
          const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
          if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
        }
      };
      arr("founder.prior_companies", j.prior_companies);
      arr("founder.co_founders",     j.co_founders);
      const num = (pred: string, v: unknown) => {
        if (typeof v === "number" && Number.isFinite(v)) {
          out.push({ predicate: pred, valueNumber: v, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
        }
      };
      num("founder.raised_total_usd", j.raised_total_usd);
      num("founder.headcount",        j.headcount);
      // Stamp the variant so the router / dashboard can distinguish founders
      // from founding-engineers without re-classifying.
      out.push({ predicate: "founder.role_variant", valueText: typeId, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      return out;
    },
  };
}

export const founderWorkflow           = makeWorkflow(makeFounderDef("founder",           "founder"));
export const coFounderWorkflow         = makeWorkflow(makeFounderDef("co_founder",        "co-founder"));
export const foundingEngineerWorkflow  = makeWorkflow(makeFounderDef("founding_engineer", "founding engineer"));
export const repeatFounderWorkflow     = makeWorkflow(makeFounderDef("repeat_founder",    "repeat founder"));
