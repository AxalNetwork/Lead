// Task #1: accelerator workflow. Program-shaped — like a firm but
// emits program_duration_weeks, cohort_size, equity_taken.

import { makeWorkflow, sameOrigin } from "./_shared";
import { FIRM_SCHEMA, type FirmExtract, mapFirm, wikipediaUrl, crunchbaseOrgUrl, linkedinCompanyUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const ACCEL_SCHEMA = {
  ...FIRM_SCHEMA,
  properties: {
    ...FIRM_SCHEMA.properties,
    program_duration_weeks: { type: "number" },
    cohort_size:            { type: "number" },
    equity_taken_pct:       { type: "number" },
    program_check_usd:      { type: "number" },
  },
} as const;

interface AccelExtract extends FirmExtract {
  program_duration_weeks?: number;
  cohort_size?: number;
  equity_taken_pct?: number;
  program_check_usd?: number;
}

const def: WorkflowDef = {
  id: "accelerator.v1",
  profile_type_id: "accelerator",
  estimated_cost_per_run: { sources: 6, ai_neurons: 0.6 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/program", "/apply", "/batch", "/cohort", "/companies"]),
    wikipediaUrl(ctx),
    crunchbaseOrgUrl(ctx),
    linkedinCompanyUrl(ctx),
  ],
  extractionSchema: ACCEL_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about a startup accelerator. Fill program_duration_weeks " +
    "(typical batch length), cohort_size (companies per batch), equity_taken_pct " +
    "(0..100), and program_check_usd (USD per accepted company). Sectors are " +
    "lowercase tags. Reply strict JSON matching the schema; omit unknowns.",
  map: ({ aiJson, source }) => {
    const j = aiJson as AccelExtract;
    const out: FactCandidate[] = mapFirm(j, source);
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const num = (pred: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push({ predicate: pred, valueNumber: v, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    num("accelerator.program_duration_weeks", j.program_duration_weeks);
    num("accelerator.cohort_size",             j.cohort_size);
    num("accelerator.equity_taken_pct",        j.equity_taken_pct);
    num("accelerator.program_check_usd",       j.program_check_usd);
    return out;
  },
};

export const acceleratorWorkflow = makeWorkflow(def);
