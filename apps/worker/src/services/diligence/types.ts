// Task #6: Diligence Checklist Runner — shared types.

import type { Env } from "../../types";

export type CheckStatus = "pass" | "fail" | "caution" | "n/a" | "needs_human";
export type Severity = "low" | "medium" | "high" | "critical";
export type Section =
  | "corporate"
  | "founders"
  | "market"
  | "product"
  | "traction"
  | "team"
  | "regulatory"
  | "financial"
  | "ip";

export interface CheckContext {
  env: Env;
  target_entity_id: string;
  triggered_by: string;
}

export interface DerivedFact {
  predicate: string;
  value_text?: string | null;
  value_number?: number | null;
  value_json?: unknown;
  confidence?: number;
}

export interface CheckResult {
  status: CheckStatus;
  severity: Severity;
  confidence: number;
  finding_md: string;
  evidence: string[];
  // Optional derived business facts the runner will mirror through insertFact.
  derived_facts?: DerivedFact[];
  // Reason code surfaced when status is `needs_human` or `n/a` (audit trail).
  reason?: string;
}

export interface CheckDefinition {
  key: string; // e.g. "corporate.delaware_confirmed"
  section: Section;
  title: string;
  severity: Severity; // default severity when the check fails
  run: (ctx: CheckContext) => Promise<CheckResult>;
}

export interface RunSummary {
  run_id: string;
  status: "completed" | "failed";
  overall_score: number;
  checks_total: number;
  checks_completed: number;
  by_status: Record<CheckStatus, number>;
}
