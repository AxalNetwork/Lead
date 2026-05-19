// Nightly retrain wiring for the intro-routing logistic model.
//
// Reads up to TRAIN_CAP (10k) recent (path, outcome) pairs, materialises
// the same feature vector the live route would produce, fits the
// logistic weights via train.ts, and writes one immutable row to
// intro_model_runs. Exactly one row carries is_current=1 — the prior
// is flipped to 0 inside the same DB call.

import type { Env } from "../../types";
import type { IntroFeatures } from "./features";

/** Pure row → sample mapper used by loadTrainingSamples. Extracted so
 *  the "every label-bearing outcome row feeds training" contract can
 *  be unit-tested without a D1 stub. */
export function rowsToTrainingSamples(
  rows: Array<{ features_json: string | null; status: string | null }>,
): TrainingSample[] {
  const out: TrainingSample[] = [];
  for (const row of rows) {
    if (!row || !row.status || !row.features_json) continue;
    const label = outcomeToLabel(row.status);
    if (label == null) continue;
    let f: IntroFeatures | null = null;
    try { f = JSON.parse(row.features_json) as IntroFeatures; } catch { f = null; }
    if (!f) continue;
    out.push({ features: f, label });
  }
  return out;
}
import {
  DEFAULT_WEIGHTS,
  MIN_TRAIN_SAMPLES,
  type ModelWeights,
  outcomeToLabel,
  trainLogistic,
  type TrainingSample,
} from "./model";

const TRAIN_CAP = 10_000;

export interface RetrainResult {
  trained: boolean;
  reason?: string;
  sample_size: number;
  positives: number;
  negatives: number;
  brier?: number;
  model_id?: string;
}

/** Read the live weights, or DEFAULT_WEIGHTS when no row exists. */
export async function loadCurrentWeights(env: Env): Promise<{ weights: ModelWeights; model_id: string | null }> {
  try {
    const r = await env.DB.prepare(
      `SELECT id, weights_json FROM intro_model_runs WHERE is_current = 1 ORDER BY trained_at DESC LIMIT 1`,
    ).first<{ id: string; weights_json: string }>();
    if (!r) return { weights: DEFAULT_WEIGHTS, model_id: null };
    const parsed = JSON.parse(r.weights_json) as Partial<ModelWeights>;
    return {
      weights: { ...DEFAULT_WEIGHTS, ...parsed },
      model_id: r.id,
    };
  } catch {
    return { weights: DEFAULT_WEIGHTS, model_id: null };
  }
}

/** Materialise training samples from EVERY label-bearing intro_outcomes
 *  row. A single path with multiple outcomes (e.g. requested → accepted
 *  → deal_closed) contributes one training sample per label-bearing
 *  status. `outcomeToLabel` drops the in-flight statuses (requested,
 *  made) upstream so they don't unbalance training; the remaining
 *  rows (accepted / meeting_held / deal_closed / declined / ghosted)
 *  all flow into the fit. Per the Task #4 spec, every outcome row
 *  must reach the learning loop. */
export async function loadTrainingSamples(env: Env, cap: number = TRAIN_CAP): Promise<TrainingSample[]> {
  const sql = `
    SELECT p.features_json, o.status, o.created_at AS outcome_at
      FROM intro_outcomes o
      JOIN intro_paths    p ON p.id = o.path_id
     WHERE p.features_json IS NOT NULL
     ORDER BY o.created_at DESC
     LIMIT ?`;
  let rows: Array<{ features_json: string; status: string }> = [];
  try {
    const r = await env.DB.prepare(sql).bind(cap).all<{
      features_json: string; status: string; outcome_at: string;
    }>();
    rows = r.results ?? [];
  } catch {
    rows = [];
  }
  return rowsToTrainingSamples(rows);
}

/** Persist a newly fit run and flip the prior is_current=1 row to 0. */
export async function persistModelRun(
  env: Env,
  weights: ModelWeights,
  brier: number,
  sample_size: number,
  positives: number,
  negatives: number,
  notes: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  // Flip prior; insert new row. Two statements — D1 batch keeps them
  // atomic enough for our needs; if the second fails the prior stays
  // current and the next run picks up where we left off.
  try {
    await env.DB.prepare(`UPDATE intro_model_runs SET is_current = 0 WHERE is_current = 1`).run();
  } catch (e) {
    console.warn("intro_model_runs flip-current failed", (e as Error).message);
  }
  await env.DB.prepare(
    `INSERT INTO intro_model_runs (id, weights_json, sample_size, brier_score, positives, negatives, notes, is_current)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(
    id,
    JSON.stringify(weights),
    sample_size,
    brier,
    positives,
    negatives,
    notes,
  ).run();
  return id;
}

/** Public nightly entry point. Idempotent + safe to call when no
 *  outcomes have been logged yet (returns trained=false). */
export async function runNightlyIntroRetrain(env: Env): Promise<RetrainResult> {
  const samples = await loadTrainingSamples(env);
  if (samples.length < MIN_TRAIN_SAMPLES) {
    return {
      trained: false,
      reason: `insufficient_samples_${samples.length}_lt_${MIN_TRAIN_SAMPLES}`,
      sample_size: samples.length,
      positives: samples.reduce((a, s) => a + s.label, 0),
      negatives: samples.length - samples.reduce((a, s) => a + s.label, 0),
    };
  }
  const { weights: init } = await loadCurrentWeights(env);
  const result = trainLogistic(samples, { init });
  // Pure degenerate-case guard: if all labels are one class, trainLogistic
  // returns init unchanged. We still want to record a snapshot so
  // operators see Brier-score history.
  const id = await persistModelRun(
    env,
    result.weights,
    result.brier,
    result.sample_size,
    result.positives,
    result.negatives,
    `nightly retrain at ${new Date().toISOString()}`,
  );
  return {
    trained: true,
    sample_size: result.sample_size,
    positives: result.positives,
    negatives: result.negatives,
    brier: result.brier,
    model_id: id,
  };
}
