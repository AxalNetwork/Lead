// Task #1: Per-Profile-Type Workflows — shared types.
//
// Every typed workflow module exports a `ProfileWorkflow` const with the
// same shape (`run(env, ctx, opts)` → `WorkflowResult`). The shared
// runner in `_shared.ts` interprets a declarative `WorkflowDef` so each
// per-type module stays small and predictable: declare sources, the AI
// extraction schema, and the predicate mapping; the runner does fetch,
// cross-source verification, persistence, and run accounting.

import type { Env } from "../../types";

export interface WorkflowContext {
  /** The URL the page classifier identified as this profile type. */
  candidateUrl: string;
  /** HTML of `candidateUrl` (already fetched + archived upstream). */
  candidateHtml: string;
  /** Hostname of `candidateUrl`, lowercased, no leading `www.`. */
  candidateHost: string;
  /** Optional pre-resolved entity. When absent, workflow writes facts
   *  against a derived stable id (see `_shared.resolveEntityId`). */
  entityId?: string | null;
  /** Display name hint (helps name-binding across sibling sources). */
  displayName?: string | null;
  /** Optional job id for fetch-log + AI accounting correlation. */
  jobId?: string | null;
}

export interface WorkflowRunOpts {
  /** Hard cap on USD cost for this single run. Default 0.05. */
  budgetUsdCap?: number;
  /** Hard cap on AI calls. Default = sources.length. */
  aiCallCap?: number;
  /** Disable the AI extraction step (heuristic-only). */
  disableAi?: boolean;
  /** Override the default observed_at timestamp. */
  observedAt?: string;
}

export interface PlannedSource {
  /** Stable bucket key — used by the cross-source verifier. */
  tag: string;
  /** Absolute URL to fetch. */
  url: string;
  /** When true, fetch failure does not count toward `sources_failed`. */
  optional?: boolean;
}

export interface FactCandidate {
  /** Canonical predicate name. See `apps/worker/src/entities/profile-predicates.ts`
   *  for the structured-row predicates; domain predicates (`aum`, `stages`,
   *  `sectors`, …) come from the e_types registry. */
  predicate: string;
  /** Exactly one of these three carries the value. */
  valueText?: string | null;
  valueNumber?: number | null;
  valueJson?: unknown;
  /** Source URL the value was extracted from. */
  sourceUrl: string;
  /** Cross-ref bucket key (matches `PlannedSource.tag`). Cross-source
   *  promotion requires the same predicate+value across ≥2 distinct
   *  tags. */
  sourceTag: string;
  /** Pre-verification confidence (0..1). */
  confidence: number;
}

export interface WorkflowError {
  tag: string;
  message: string;
}

export interface WorkflowResult {
  workflow_id: string;
  profile_type_id: string;
  entity_id: string | null;
  status: "success" | "partial" | "failed" | "skipped";
  sources_planned: number;
  sources_fetched: number;
  sources_failed: number;
  facts_written: number;
  facts_verified: number;
  ai_calls: number;
  ai_neurons: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  errors: WorkflowError[];
  duration_ms: number;
}

export interface EstimatedCost {
  sources: number;     // expected source fetches per run
  ai_neurons: number;  // expected AI neurons consumed per run
}

export interface ProfileWorkflow {
  id: string;                                // e.g. "investor_vc.v1"
  profile_type_id: string;                   // e.g. "investor_vc"
  estimated_cost_per_run: EstimatedCost;
  run(env: Env, ctx: WorkflowContext, opts?: WorkflowRunOpts): Promise<WorkflowResult>;
}

/**
 * Declarative description of a workflow consumed by `runStandardWorkflow`.
 * Per-type modules build one of these; the runner does the rest.
 */
export interface WorkflowDef {
  id: string;
  profile_type_id: string;
  estimated_cost_per_run: EstimatedCost;
  /** Produces the source plan from the candidate. Common helpers in
   *  `_shared.ts` (`sameOrigin`, `pathChildren`) build the common cases. */
  plan(ctx: WorkflowContext): PlannedSource[];
  /** JSON schema passed as `response_format` to Workers AI. The runner
   *  validates structurally only — semantic mapping happens in `map`. */
  extractionSchema: Record<string, unknown>;
  /** System prompt steering the extractor. The user prompt is generated
   *  by the runner (URL + cleaned page text). */
  systemPrompt: string;
  /** Maps the AI response (already parsed JSON) into FactCandidates. */
  map(args: { aiJson: unknown; source: PlannedSource; ctx: WorkflowContext }): FactCandidate[];
  /** Optional override of the default model (Llama 3.1 8b fast). */
  model?: string;
}
