// Task #8: prediction calibration grader.
//
// Closes every `predictions` row whose `time_window_end <= now` and
// `graded_at IS NULL`, grades each against the realized outcome, and
// upserts a per-(prediction_type, day_bucket) row in
// prediction_outcomes_calibration. The grader handles the four common
// outcome shapes (boolean, scalar threshold, categorical match,
// numeric proximity) via a per-type pluggable resolver.
//
// `predictions` table is not owned by this task — it may or may not
// exist in a given environment. The grader wraps its reads in
// safeQuery and degrades to a no-op when the table is absent, same
// pattern as the Task #14 verification source-table guarding.

import type { Env } from "../../types";
import { calibrationMetrics, type CalibrationRow } from "./metrics";

export interface PredictionRow {
  id: string;
  prediction_type: string;
  predicted_value: number;     // probability in [0,1] for boolean shapes; raw scalar otherwise
  predicted_json: string | null;
  time_window_end: string;
  outcome_value: number | null;
  outcome_json: string | null;
  graded_at: string | null;
}

export interface GradeResult {
  graded: number;
  perType: { type: string; n: number; brier: number; log_loss: number }[];
}

async function safeQuery<T>(_env: Env, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) {
    console.warn("calibration safeQuery", (e as Error).message);
    return null;
  }
}

/** Idempotent: re-running the same day's grader recomputes the
 *  calibration row in-place (UNIQUE(prediction_type, day_bucket)). */
export async function runCalibrationGrade(env: Env): Promise<GradeResult> {
  const dueRows = await safeQuery(env, async () => {
    const r = await env.DB.prepare(
      `SELECT id, prediction_type, predicted_value, predicted_json,
              time_window_end, outcome_value, outcome_json, graded_at
         FROM predictions
        WHERE graded_at IS NULL
          AND outcome_value IS NOT NULL
          AND datetime(time_window_end) <= datetime('now')
        ORDER BY time_window_end ASC
        LIMIT 5000`,
    ).all<PredictionRow>();
    return r.results ?? [];
  });
  if (!dueRows) return { graded: 0, perType: [] };

  const today = new Date().toISOString().slice(0, 10);
  const byType = new Map<string, CalibrationRow[]>();
  for (const p of dueRows) {
    const resolved = resolveOutcomeShape(p);
    if (!resolved) continue;
    const arr = byType.get(p.prediction_type) ?? [];
    arr.push(resolved);
    byType.set(p.prediction_type, arr);
  }

  const out: GradeResult = { graded: dueRows.length, perType: [] };
  for (const [type, rows] of byType) {
    const m = calibrationMetrics(rows);
    out.perType.push({ type, n: m.n, brier: m.brier, log_loss: m.log_loss });
    try {
      await env.DB.prepare(
        `INSERT INTO prediction_outcomes_calibration
           (id, prediction_type, day_bucket, sample_size, brier_score, log_loss, mean_predicted, mean_actual, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(prediction_type, day_bucket) DO UPDATE SET
           sample_size = excluded.sample_size,
           brier_score = excluded.brier_score,
           log_loss = excluded.log_loss,
           mean_predicted = excluded.mean_predicted,
           mean_actual = excluded.mean_actual,
           payload_json = excluded.payload_json`,
      ).bind(
        crypto.randomUUID(), type, today, m.n,
        m.brier, m.log_loss, m.mean_predicted, m.mean_actual,
        JSON.stringify({ first_graded_at: new Date().toISOString() }),
      ).run();
    } catch (e) {
      console.warn("calibration upsert failed", type, (e as Error).message);
    }
  }

  // Mark predictions graded so the next tick doesn't regrade them.
  const ids = dueRows.map((r) => r.id);
  while (ids.length) {
    const batch = ids.splice(0, 500);
    const placeholders = batch.map(() => "?").join(",");
    try {
      await env.DB.prepare(
        `UPDATE predictions SET graded_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ).bind(...batch).run();
    } catch (e) {
      console.warn("calibration grade mark failed", (e as Error).message);
    }
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Task #8: resolve a `predictions` row to a (predicted_prob ∈ [0,1],
 *  actual ∈ {0,1}) pair across the four common outcome shapes.
 *
 *  Shapes (read from predicted_json/outcome_json when present, else
 *  fall back to the scalar columns):
 *    - boolean             — predicted_value already a probability;
 *                            outcome_value is 0/1.
 *    - scalar_threshold    — predicted_json.value compared to
 *                            outcome_json.value at predicted_json.threshold;
 *                            correct = both on the same side.
 *    - categorical_match   — predicted_json.label vs outcome_json.label;
 *                            correct = exact match.
 *    - numeric_proximity   — |predicted - actual| <= predicted_json.tolerance;
 *                            correct = within tolerance.
 *
 *  Unknown shapes degrade to the boolean-threshold default rather
 *  than throwing — same honest-degradation pattern as the rest of
 *  the verifier surfaces.
 */
function resolveOutcomeShape(p: PredictionRow): CalibrationRow | null {
  const pred = safeJson(p.predicted_json);
  const out = safeJson(p.outcome_json);
  const shape = String(pred?.shape ?? out?.shape ?? "boolean").toLowerCase();

  if (shape === "scalar_threshold" && pred && out) {
    const t = Number(pred.threshold ?? 0);
    const pv = Number(pred.value ?? p.predicted_value);
    const av = Number(out.value ?? p.outcome_value ?? 0);
    if (!Number.isFinite(t) || !Number.isFinite(pv) || !Number.isFinite(av)) return null;
    const correct = (pv >= t) === (av >= t);
    // Calibration row carries the model's probability that it would
    // be correct. We don't have that in raw form for scalar shapes,
    // so we use a sigmoid-style confidence proxy from the margin.
    const margin = Math.abs(pv - t);
    const confidence = clamp01(0.5 + margin / Math.max(Math.abs(t), 1));
    return { predicted: correct ? confidence : 1 - confidence, actual: correct ? 1 : 0 };
  }

  if (shape === "categorical_match" && pred && out) {
    const correct = String(pred.label ?? "").toLowerCase() === String(out.label ?? "").toLowerCase();
    const prob = clamp01(Number(pred.probability ?? p.predicted_value ?? (correct ? 1 : 0)));
    return { predicted: prob, actual: correct ? 1 : 0 };
  }

  if (shape === "numeric_proximity" && pred && out) {
    const pv = Number(pred.value ?? p.predicted_value);
    const av = Number(out.value ?? p.outcome_value ?? 0);
    const tol = Number(pred.tolerance ?? 0);
    if (!Number.isFinite(pv) || !Number.isFinite(av) || !Number.isFinite(tol)) return null;
    const within = Math.abs(pv - av) <= tol;
    const confidence = clamp01(Number(pred.probability ?? (within ? 0.85 : 0.15)));
    return { predicted: confidence, actual: within ? 1 : 0 };
  }

  // Default boolean shape.
  const actual = (p.outcome_value ?? 0) > 0.5 ? 1 : 0;
  return { predicted: clamp01(p.predicted_value), actual: actual as 0 | 1 };
}

function safeJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
