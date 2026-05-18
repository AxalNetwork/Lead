// Task #1: generic fallback workflow.
//
// Used when a page classifies as a profile but its type is unknown or
// no dedicated module is registered. Fetches only the candidate page,
// runs a permissive AI extractor that emits free-form (predicate,
// value) tuples, and persists with capped confidence so downstream
// scoring can distinguish a typed-workflow write from a fallback one.

import { makeWorkflow } from "./_shared";
import type { FactCandidate, WorkflowDef } from "./_types";

const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          predicate: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["predicate", "value"],
      },
    },
  },
  required: ["facts"],
} as const;

const def: WorkflowDef = {
  id: "_default.v1",
  profile_type_id: "_default",
  estimated_cost_per_run: { sources: 1, ai_neurons: 0.1 },
  plan: () => [], // candidate only
  extractionSchema: DEFAULT_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract structured facts about the primary entity on this page. " +
    "Each fact is a (predicate, value, confidence) triple. Use lowercase " +
    "snake_case predicates (e.g. 'display_name', 'one_liner', 'sector', " +
    "'location_city'). Skip navigation, footers, and unrelated content. " +
    "Reply strict JSON: {facts:[{predicate, value, confidence:0..1}]}.",
  map: ({ aiJson, source }) => {
    const j = aiJson as { facts?: Array<{ predicate?: string; value?: string; confidence?: number }> };
    if (!Array.isArray(j?.facts)) return [];
    const out: FactCandidate[] = [];
    for (const f of j.facts) {
      const pred = typeof f?.predicate === "string" ? f.predicate.trim().toLowerCase() : "";
      const val = typeof f?.value === "string" ? f.value.trim() : "";
      if (!pred || !val) continue;
      out.push({
        predicate: pred,
        valueText: val,
        sourceUrl: source.url,
        sourceTag: source.tag,
        confidence: Math.min(0.7, Math.max(0.1, Number(f.confidence ?? 0.5))),
      });
    }
    return out;
  },
};

export const defaultWorkflow = makeWorkflow(def);
