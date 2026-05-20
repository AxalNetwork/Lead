// Task #4 (Relationship Inference Worker): shared types.

import type { EdgeKind } from "./baselines";

export type { EdgeKind };

/**
 * Output shape every extractor returns. RHS entity resolution must
 * happen INSIDE the extractor — strings that don't resolve to a
 * `u_entities.id` are dropped and counted under `unresolved_count`
 * in the run summary; they MUST NOT be returned as proposals.
 */
export interface EdgeProposal {
  src_entity_id: string;
  dst_entity_id: string;
  kind: EdgeKind;
  /** Tag stamped on rel_edges.source — drives baseline lookup. */
  source: string;
  valid_from?: string | null;
  valid_to?: string | null;
  evidence_url?: string | null;
  backing_fact_ids?: string[];
}

export interface ExtractOpts {
  /** Scope to a single entity (incremental pass). When null/undefined, a full pass. */
  entityId?: string | null;
  /** Only consider source rows newer than this ISO timestamp. */
  since?: string | null;
  /** Hard cap on rows scanned per extractor — orchestrator default 5000. */
  limit?: number;
}

export interface ExtractResult {
  proposals: EdgeProposal[];
  unresolved_count: number;
  scanned: number;
}

export interface ExtractorRun {
  proposed: number;
  inserted: number;
  merged: number;
  unresolved: number;
  scanned: number;
  errors: number;
  error_messages: string[];
}

export interface OrchestratorSummary {
  by_extractor: Record<string, ExtractorRun>;
  total_edges: number;
  duration_ms: number;
}
