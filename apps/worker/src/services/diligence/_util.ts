// Task #6: shared helpers for check executors.
//
// `safeQuery` wraps a D1 lookup in try/catch and returns a sentinel
// `{ ok:false, reason }` value so check executors degrade to
// `needs_human` rather than tripping the whole run when a source
// table is missing in a given environment (test DBs, fresh installs).
// Same honest-degradation pattern as the Task #14 verification runner.

import type { Env } from "../../types";
import type { CheckResult, CheckStatus, Severity } from "./types";

export interface SafeQueryOk<T> {
  ok: true;
  value: T;
}
export interface SafeQueryErr {
  ok: false;
  reason: string;
  error?: string;
}

export async function safeQuery<T>(
  fn: () => Promise<T>,
  reasonOnError: string,
): Promise<SafeQueryOk<T> | SafeQueryErr> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: reasonOnError, error: (e as Error).message };
  }
}

export function needsHuman(
  title: string,
  reason: string,
  severity: Severity = "medium",
): CheckResult {
  return {
    status: "needs_human",
    severity,
    confidence: 0,
    finding_md: `**${title}** — needs human review. Reason: \`${reason}\`.`,
    evidence: [],
    reason,
  };
}

export function naResult(title: string, reason: string): CheckResult {
  return {
    status: "n/a",
    severity: "low",
    confidence: 1,
    finding_md: `**${title}** — not applicable. ${reason}`,
    evidence: [],
    reason,
  };
}

export function passResult(
  title: string,
  finding: string,
  evidence: string[] = [],
  confidence = 0.9,
): CheckResult {
  return {
    status: "pass",
    severity: "low",
    confidence,
    finding_md: `**${title}** — ✓ ${finding}`,
    evidence,
  };
}

export function failResult(
  title: string,
  finding: string,
  severity: Severity,
  evidence: string[] = [],
  confidence = 0.8,
): CheckResult {
  return {
    status: "fail",
    severity,
    confidence,
    finding_md: `**${title}** — ✗ ${finding}`,
    evidence,
  };
}

export function cautionResult(
  title: string,
  finding: string,
  severity: Severity,
  evidence: string[] = [],
  confidence = 0.7,
): CheckResult {
  return {
    status: "caution",
    severity,
    confidence,
    finding_md: `**${title}** — ⚠ ${finding}`,
    evidence,
  };
}

// Pull the current value of a single predicate from facts.is_current=1.
// Returns null on any query/missing row failure. Pure helper.
export async function readCurrentFact(
  env: Env,
  entityId: string,
  predicate: string,
): Promise<{ value_text: string | null; value_number: number | null; value_json: string | null; evidence_url: string | null } | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT value_text, value_number, value_json, evidence_url
         FROM facts
        WHERE entity_id = ? AND predicate = ? AND is_current = 1
        ORDER BY observed_at DESC LIMIT 1`,
    ).bind(entityId, predicate).first<{
      value_text: string | null;
      value_number: number | null;
      value_json: string | null;
      evidence_url: string | null;
    }>();
    return r ?? null;
  } catch {
    return null;
  }
}

export function statusToWeight(status: CheckStatus): number {
  // Score weights — drive overall_score in [0, 100].
  switch (status) {
    case "pass": return 1.0;
    case "caution": return 0.6;
    case "needs_human": return 0.5; // neutral: counts as half-credit
    case "n/a": return 1.0; // not applicable is treated as a pass for scoring
    case "fail": return 0.0;
  }
}

export function severityWeight(severity: Severity): number {
  switch (severity) {
    case "low": return 1;
    case "medium": return 2;
    case "high": return 4;
    case "critical": return 8;
  }
}
