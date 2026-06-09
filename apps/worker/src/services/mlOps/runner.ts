// Task #8: eval runner. Pure orchestration — calls the per-task
// predictor (provided by the caller) over every example in a dataset
// and reduces the predictions to a metrics blob via the helpers in
// metrics.ts. The runner persists the result; metric helpers do not
// touch the DB.

import type { Env } from "../../types";
import {
  classificationMetrics, pairPRF1, fieldLevelF1, calibrationMetrics,
} from "./metrics";

export type TaskKey =
  | "page_classification" | "csv_mapping" | "role_inference"
  | "deal_extraction" | "entity_dedupe" | "founder_background";

export interface DatasetRow {
  id: string;
  task_key: TaskKey;
  name: string;
  schema_version: number;
  active: number;
}

export interface ExampleRow {
  id: string;
  example_key: string;
  input: unknown;
  gold: unknown;
}

export interface PredictResult {
  predicted: unknown;
  /** Optional probability for calibration metrics (deal_extraction confidence, etc). */
  probability?: number;
  /** Optional: caller wants to flag this row as unconfigured (e.g. AI key missing). */
  unconfigured?: boolean;
  /** Optional reason if unconfigured. */
  reason?: string;
}

export type Predictor = (input: unknown, example_key: string) => Promise<PredictResult> | PredictResult;

export interface RunOptions {
  triggered_by?: "manual" | "nightly" | "ci";
  prompt_version_id?: string | null;
  prompt_key?: string | null;
  prompt_version?: string | null;
  model_version?: string | null;
  sampleCap?: number;
}

export interface RunResult {
  id: string;
  dataset_id: string;
  task_key: TaskKey;
  status: "ok" | "unconfigured" | "error";
  status_reason?: string;
  metrics: Record<string, unknown>;
  sample: { example_key: string; predicted: unknown; gold: unknown; correct: boolean }[];
  n_examples: number;
  n_correct: number;
  duration_ms: number;
}

export async function listActiveDatasets(env: Env): Promise<DatasetRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, task_key, name, schema_version, active FROM eval_datasets
      WHERE active = 1 ORDER BY task_key ASC`,
  ).all<DatasetRow>();
  return r.results ?? [];
}

export async function getDataset(env: Env, datasetId: string): Promise<DatasetRow | null> {
  return env.DB.prepare(
    `SELECT id, task_key, name, schema_version, active FROM eval_datasets WHERE id = ? LIMIT 1`,
  ).bind(datasetId).first<DatasetRow>();
}

export async function getDatasetByTaskKey(env: Env, taskKey: TaskKey): Promise<DatasetRow | null> {
  return env.DB.prepare(
    `SELECT id, task_key, name, schema_version, active FROM eval_datasets
      WHERE task_key = ? AND active = 1 ORDER BY schema_version DESC LIMIT 1`,
  ).bind(taskKey).first<DatasetRow>();
}

export async function listExamples(env: Env, datasetId: string): Promise<ExampleRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, example_key, input_json, gold_output_json FROM eval_examples
      WHERE dataset_id = ? ORDER BY example_key ASC`,
  ).bind(datasetId).all<{ id: string; example_key: string; input_json: string; gold_output_json: string }>();
  return (r.results ?? []).map((x) => ({
    id: x.id, example_key: x.example_key,
    input: safeJson(x.input_json), gold: safeJson(x.gold_output_json),
  }));
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export async function runEval(
  env: Env,
  datasetId: string,
  predictor: Predictor,
  opts: RunOptions = {},
): Promise<RunResult> {
  const ds = await getDataset(env, datasetId);
  if (!ds) throw new Error("dataset_not_found");
  const examples = await listExamples(env, datasetId);
  const start = Date.now();

  const predictions: { example_key: string; predicted: unknown; gold: unknown; probability?: number }[] = [];
  let unconfiguredReason: string | null = null;

  for (const ex of examples) {
    try {
      const r = await predictor(ex.input, ex.example_key);
      if (r.unconfigured) {
        unconfiguredReason = r.reason ?? "unconfigured";
        break;
      }
      predictions.push({ example_key: ex.example_key, predicted: r.predicted, gold: ex.gold, probability: r.probability });
    } catch (e) {
      predictions.push({ example_key: ex.example_key, predicted: { __error: (e as Error).message }, gold: ex.gold });
    }
  }

  const durationMs = Date.now() - start;
  const runId = crypto.randomUUID();

  if (unconfiguredReason) {
    await env.DB.prepare(
      `INSERT INTO eval_runs
         (id, dataset_id, task_key, prompt_version_id, prompt_key, prompt_version, model_version,
          status, status_reason, n_examples, n_correct, duration_ms, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfigured', ?, 0, 0, ?, ?)`,
    ).bind(
      runId, datasetId, ds.task_key,
      opts.prompt_version_id ?? null, opts.prompt_key ?? null, opts.prompt_version ?? null,
      opts.model_version ?? null, unconfiguredReason, durationMs, opts.triggered_by ?? "manual",
    ).run();
    return {
      id: runId, dataset_id: datasetId, task_key: ds.task_key,
      status: "unconfigured", status_reason: unconfiguredReason,
      metrics: {}, sample: [], n_examples: 0, n_correct: 0, duration_ms: durationMs,
    };
  }

  const metrics = computeMetrics(ds.task_key as TaskKey, predictions);
  const correctRows = predictions.map((p) => ({ ...p, correct: isCorrect(ds.task_key as TaskKey, p.predicted, p.gold) }));
  const nCorrect = correctRows.filter((p) => p.correct).length;
  const sampleCap = opts.sampleCap ?? 25;
  const sample = correctRows.slice(0, sampleCap).map((p) => ({
    example_key: p.example_key, predicted: p.predicted, gold: p.gold, correct: p.correct,
  }));

  await env.DB.prepare(
    `INSERT INTO eval_runs
       (id, dataset_id, task_key, prompt_version_id, prompt_key, prompt_version, model_version,
        status, metrics_json, sample_predictions_json, n_examples, n_correct, duration_ms, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    runId, datasetId, ds.task_key,
    opts.prompt_version_id ?? null, opts.prompt_key ?? null, opts.prompt_version ?? null,
    opts.model_version ?? null,
    JSON.stringify(metrics), JSON.stringify(sample),
    predictions.length, nCorrect, durationMs, opts.triggered_by ?? "manual",
  ).run();

  return {
    id: runId, dataset_id: datasetId, task_key: ds.task_key,
    status: "ok", metrics, sample, n_examples: predictions.length, n_correct: nCorrect,
    duration_ms: durationMs,
  };
}

function isCorrect(task: TaskKey, predicted: unknown, gold: unknown): boolean {
  if (task === "entity_dedupe") {
    return Boolean((predicted as { same?: boolean })?.same) === Boolean((gold as { same?: boolean })?.same);
  }
  if (task === "founder_background") {
    return Boolean((predicted as { supported?: boolean })?.supported) === Boolean((gold as { supported?: boolean })?.supported);
  }
  if (task === "page_classification") {
    return String((predicted as { label?: string })?.label ?? "").toLowerCase() ===
           String((gold as { label?: string })?.label ?? "").toLowerCase();
  }
  if (task === "csv_mapping") {
    return String((predicted as { field?: string })?.field ?? "").toLowerCase() ===
           String((gold as { field?: string })?.field ?? "").toLowerCase();
  }
  if (task === "role_inference") {
    return String((predicted as { role?: string })?.role ?? "").toLowerCase() ===
           String((gold as { role?: string })?.role ?? "").toLowerCase();
  }
  if (task === "deal_extraction") {
    const p = (predicted ?? {}) as Record<string, unknown>;
    const g = (gold ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(g)) {
      const gv = g[k]; const pv = p[k];
      if (Array.isArray(gv)) {
        if (!Array.isArray(pv)) return false;
        const gs = [...gv].map((x) => String(x).toLowerCase()).sort();
        const ps = [...pv].map((x) => String(x).toLowerCase()).sort();
        if (gs.length !== ps.length || !gs.every((v, i) => v === ps[i])) return false;
      } else if (String(gv).toLowerCase() !== String(pv).toLowerCase()) return false;
    }
    return true;
  }
  return false;
}

function computeMetrics(task: TaskKey, preds: { predicted: unknown; gold: unknown; probability?: number }[]): Record<string, unknown> {
  if (task === "page_classification" || task === "csv_mapping" || task === "role_inference") {
    const fieldName = task === "page_classification" ? "label" : task === "csv_mapping" ? "field" : "role";
    const rows = preds.map((p) => ({
      predicted: String((p.predicted as Record<string, unknown>)?.[fieldName] ?? "unknown").toLowerCase(),
      gold: String((p.gold as Record<string, unknown>)?.[fieldName] ?? "unknown").toLowerCase(),
    }));
    return classificationMetrics(rows) as unknown as Record<string, unknown>;
  }
  if (task === "entity_dedupe") {
    const rows = preds.map((p) => ({
      predicted: Boolean((p.predicted as { same?: boolean })?.same),
      gold: Boolean((p.gold as { same?: boolean })?.same),
    }));
    return pairPRF1(rows) as unknown as Record<string, unknown>;
  }
  if (task === "founder_background") {
    const rows = preds.map((p) => ({
      predicted: Boolean((p.predicted as { supported?: boolean })?.supported),
      gold: Boolean((p.gold as { supported?: boolean })?.supported),
    }));
    const pr = pairPRF1(rows);
    let brier: ReturnType<typeof calibrationMetrics> | null = null;
    if (preds.some((p) => typeof p.probability === "number")) {
      brier = calibrationMetrics(preds.map((p) => ({
        predicted: typeof p.probability === "number" ? p.probability : ((p.predicted as { supported?: boolean })?.supported ? 1 : 0),
        actual: ((p.gold as { supported?: boolean })?.supported ? 1 : 0) as 0 | 1,
      })));
    }
    return { ...pr, ...(brier ? { brier: brier.brier, log_loss: brier.log_loss } : {}) } as Record<string, unknown>;
  }
  if (task === "deal_extraction") {
    const rows = preds.map((p) => ({
      predicted: (p.predicted ?? {}) as Record<string, unknown>,
      gold: (p.gold ?? {}) as Record<string, unknown>,
    }));
    return fieldLevelF1(rows) as unknown as Record<string, unknown>;
  }
  return {};
}

/** Convenience: run all active datasets sequentially. Used by the
 *  nightly sweep + CI gate. */
export async function runAllActive(
  env: Env,
  predictorFor: (task: TaskKey) => Predictor,
  opts: RunOptions = {},
): Promise<RunResult[]> {
  const ds = await listActiveDatasets(env);
  const out: RunResult[] = [];
  for (const d of ds) {
    try {
      out.push(await runEval(env, d.id, predictorFor(d.task_key as TaskKey), opts));
    } catch (e) {
      console.warn("runEval failed", d.task_key, (e as Error).message);
    }
  }
  return out;
}
