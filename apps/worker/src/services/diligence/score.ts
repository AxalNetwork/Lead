// Task #6: overall-score aggregator. Pure: no DB access.

import type { CheckResult, CheckStatus, Severity } from "./types";
import { severityWeight, statusToWeight } from "./_util";

export interface ScoredResult {
  status: CheckStatus;
  severity: Severity;
}

// Severity-weighted percentage in [0, 100]. n/a checks contribute their
// weight as full credit so a template with many inapplicable checks is
// not penalized.
export function computeOverallScore(results: ScoredResult[]): number {
  if (results.length === 0) return 0;
  let weighted = 0;
  let total = 0;
  for (const r of results) {
    const w = severityWeight(r.severity);
    total += w;
    weighted += w * statusToWeight(r.status);
  }
  if (total === 0) return 0;
  return Math.round((weighted / total) * 1000) / 10; // one decimal place
}

export function tallyByStatus(results: ScoredResult[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = {
    pass: 0,
    fail: 0,
    caution: 0,
    "n/a": 0,
    needs_human: 0,
  };
  for (const r of results) out[r.status] += 1;
  return out;
}

export function isFailLike(r: Pick<CheckResult, "status">): boolean {
  // Re-run-failed filter: failures + cautions + missing-input cases.
  return r.status === "fail" || r.status === "caution" || r.status === "needs_human";
}
