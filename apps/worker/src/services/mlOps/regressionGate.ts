// Task #8: deploy-time regression gate.
//
// `compareEval` reads the latest `ok` eval_runs row for every active
// dataset and compares its metrics against the prior `ok` run (any
// prompt_version_id). Any task that regresses more than 5% on a key
// metric fails the gate. CI calls this via the `eval-gate` script;
// non-zero exit blocks the deploy.

import type { Env } from "../../types";
import { regressionGate } from "./metrics";

export interface GateRow {
  task_key: string;
  dataset_id: string;
  current_run_id: string;
  previous_run_id: string | null;
  passed: boolean;
  regressions: { metric: string; previous: number; current: number; delta: number }[];
  skipped_reason?: string;
}

export interface GateReport {
  passed: boolean;
  thresholdPct: number;
  rows: GateRow[];
}

export async function runRegressionGate(env: Env, thresholdPct = 5): Promise<GateReport> {
  const datasets = await env.DB.prepare(
    `SELECT id, task_key FROM eval_datasets WHERE active = 1`,
  ).all<{ id: string; task_key: string }>();
  const rows: GateRow[] = [];
  let allPassed = true;
  for (const d of datasets.results ?? []) {
    const recent = await env.DB.prepare(
      `SELECT id, metrics_json FROM eval_runs
        WHERE dataset_id = ? AND status = 'ok'
        ORDER BY created_at DESC LIMIT 2`,
    ).bind(d.id).all<{ id: string; metrics_json: string }>();
    const list = recent.results ?? [];
    if (list.length === 0) {
      rows.push({ task_key: d.task_key, dataset_id: d.id, current_run_id: "", previous_run_id: null, passed: true, regressions: [], skipped_reason: "no_runs" });
      continue;
    }
    if (list.length === 1) {
      rows.push({ task_key: d.task_key, dataset_id: d.id, current_run_id: list[0].id, previous_run_id: null, passed: true, regressions: [], skipped_reason: "first_run" });
      continue;
    }
    const current = safeMetrics(list[0].metrics_json);
    const previous = safeMetrics(list[1].metrics_json);
    const r = regressionGate(previous, current, thresholdPct);
    if (!r.passed) allPassed = false;
    rows.push({ task_key: d.task_key, dataset_id: d.id, current_run_id: list[0].id, previous_run_id: list[1].id, passed: r.passed, regressions: r.regressions });
  }
  return { passed: allPassed, thresholdPct, rows };
}

function safeMetrics(s: string | null): Record<string, number> {
  if (!s) return {};
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number") out[k] = v;
    return out;
  } catch { return {}; }
}
