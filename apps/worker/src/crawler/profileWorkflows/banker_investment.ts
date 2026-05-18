// Task #1: banker_investment workflow.
//
// Fetches the firm bio, an SEC EDGAR S-1 underwriter lookup bootstrap,
// LinkedIn public, and a league-table search. Extracts current bank,
// title, FINRA CRD if disclosed, and notable transactions.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, searchUrls, namedQuery } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const BANK_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    bank_employer: { type: "string" },
    finra_crd:     { type: "string" },
    notable_transactions: { type: "array", items: { type: "string" } },
    coverage_sectors:     { type: "array", items: { type: "string" } },
  },
} as const;

interface BankExtract extends PersonExtract {
  bank_employer?: string;
  finra_crd?: string;
  notable_transactions?: string[];
  coverage_sectors?: string[];
}

const def: WorkflowDef = {
  id: "banker_investment.v1",
  profile_type_id: "banker_investment",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/professionals"]),
    ...searchUrls(namedQuery(ctx, "investment banker SEC S-1 underwriter")).slice(0, 1),
    ...searchUrls(namedQuery(ctx, "investment banker league table")).slice(0, 1),
  ],
  extractionSchema: BANK_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about an investment banker from a firm bio or SEC " +
    "S-1 'Underwriters' section. bank_employer is the current bank " +
    "(e.g. 'Goldman Sachs'). finra_crd is the FINRA CRD # if shown. " +
    "notable_transactions names public deals the banker led. " +
    "coverage_sectors are lowercase tags. Reply strict JSON matching " +
    "the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as BankExtract;
    const out: FactCandidate[] = mapPerson(j, source, "banker");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    if (typeof j.bank_employer === "string" && j.bank_employer.trim()) {
      out.push({ predicate: "banker.bank_employer", valueText: j.bank_employer.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    if (typeof j.finra_crd === "string" && j.finra_crd.trim()) {
      out.push({ predicate: "banker.finra_crd", valueText: j.finra_crd.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
    }
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    arr("banker.notable_transactions", j.notable_transactions);
    arr("banker.coverage_sectors",     j.coverage_sectors);
    return out;
  },
};

export const bankerInvestmentWorkflow = makeWorkflow(def);
