// Task #8: ML Quality Ops routes. Mounted at /api/ml.

import { Hono } from "hono";
import type { Env } from "../types";
import { loadBundledDatasets } from "../services/mlOps/loader";
import {
  listActiveDatasets, getDataset, getDatasetByTaskKey,
  runEval, runAllActive, type TaskKey,
} from "../services/mlOps/runner";
import { predictorFor } from "../services/mlOps/predictors";
import { llmPredictorFor } from "../services/mlOps/llmPredictors";
import { listPromptVersions, promotePrompt, setRolloutPct, getPrompt } from "../services/mlOps/prompts";
import { runRegressionGate } from "../services/mlOps/regressionGate";
import { runCalibrationGrade } from "../services/mlOps/calibration";

type Vars = { Bindings: Env; Variables: { email: string; is_admin: boolean } };

export const mlRoute = new Hono<Vars>();

mlRoute.get("/eval/datasets", async (c) => {
  const ds = await listActiveDatasets(c.env);
  const withCounts = await Promise.all(ds.map(async (d) => {
    const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM eval_examples WHERE dataset_id = ?`)
      .bind(d.id).first<{ n: number }>();
    const latest = await c.env.DB.prepare(
      `SELECT id, status, metrics_json, n_examples, n_correct, created_at
         FROM eval_runs WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(d.id).first<{ id: string; status: string; metrics_json: string | null; n_examples: number; n_correct: number; created_at: string }>();
    return {
      ...d, example_count: cnt?.n ?? 0,
      latest_run: latest ? {
        id: latest.id, status: latest.status, created_at: latest.created_at,
        n_examples: latest.n_examples, n_correct: latest.n_correct,
        metrics: safeJson(latest.metrics_json),
      } : null,
    };
  }));
  return c.json({ datasets: withCounts });
});

mlRoute.get("/eval/datasets/:id/runs", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(
    `SELECT id, status, status_reason, prompt_version, model_version,
            metrics_json, n_examples, n_correct, duration_ms, triggered_by, created_at
       FROM eval_runs WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 50`,
  ).bind(id).all();
  return c.json({ runs: (r.results ?? []).map((row) => ({
    ...row, metrics: safeJson((row as { metrics_json?: string }).metrics_json ?? null),
  })) });
});

mlRoute.get("/eval/runs/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(id).first<{ metrics_json: string | null; sample_predictions_json: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({
    ...row,
    metrics: safeJson(row.metrics_json), sample: safeJson(row.sample_predictions_json),
  });
});

// `mode` selects the predictor path:
//   "heuristic" (default) — deterministic reference predictors in
//     `services/mlOps/predictors.ts`. Used by the nightly sweep and
//     the CI candidate-commit gate so a missing OPENAI_API_KEY can
//     never silently void a quality check.
//   "production" — exercises the SAME prompt + model path the worker
//     uses in production via `getPrompt(prompt_key)` + the active
//     model_hint. Per the spec's "runs against current prompt/model
//     version" criterion this is the path operators trigger when a
//     prompt is promoted; runs are stamped with the resolved
//     prompt_version + model_version. Returns `unconfigured` if
//     OPENAI_API_KEY is missing or no prompt is registered for the
//     task's prompt_key (Task #14 honest-degradation pattern).
async function resolveProvenance(env: Env, task: TaskKey): Promise<{ prompt_key: string | null; prompt_version: string | null; prompt_version_id: string | null; model_version: string | null }> {
  const PROMPT_KEY_FOR_TASK: Partial<Record<TaskKey, string>> = {
    deal_extraction: "deal_extractor.v1",
    page_classification: "page_classifier.v1",
    founder_background: "founder_background.v1",
  };
  const key = PROMPT_KEY_FOR_TASK[task];
  if (!key) return { prompt_key: null, prompt_version: null, prompt_version_id: null, model_version: null };
  const p = await getPrompt(env, key);
  if (!p) return { prompt_key: key, prompt_version: null, prompt_version_id: null, model_version: null };
  return { prompt_key: key, prompt_version: p.version, prompt_version_id: p.id, model_version: p.model_hint };
}

mlRoute.post("/eval/run", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { dataset_id?: string; task_key?: TaskKey; triggered_by?: "manual" | "nightly" | "ci"; mode?: "heuristic" | "production" };
  const ds = body.dataset_id ? await getDataset(c.env, body.dataset_id)
    : body.task_key ? await getDatasetByTaskKey(c.env, body.task_key)
    : null;
  if (!ds) return c.json({ error: "dataset_not_found" }, 404);
  const mode = body.mode ?? "heuristic";
  const task = ds.task_key as TaskKey;
  if (mode === "production") {
    const prov = await resolveProvenance(c.env, task);
    const result = await runEval(c.env, ds.id, llmPredictorFor(c.env, task), {
      triggered_by: body.triggered_by ?? "manual",
      prompt_key: prov.prompt_key,
      prompt_version: prov.prompt_version,
      prompt_version_id: prov.prompt_version_id,
      model_version: prov.model_version ?? "gpt-4o-mini",
    });
    return c.json({ run: result, mode });
  }
  const result = await runEval(c.env, ds.id, predictorFor(task), {
    triggered_by: body.triggered_by ?? "manual",
    model_version: "heuristic:v1",
  });
  return c.json({ run: result, mode });
});

mlRoute.post("/eval/run-all", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { mode?: "heuristic" | "production"; triggered_by?: "manual" | "nightly" | "ci" };
  const mode = body.mode ?? "heuristic";
  if (mode === "production") {
    const datasets = await listActiveDatasets(c.env);
    const runs = [];
    for (const ds of datasets) {
      const task = ds.task_key as TaskKey;
      const prov = await resolveProvenance(c.env, task);
      runs.push(await runEval(c.env, ds.id, llmPredictorFor(c.env, task), {
        triggered_by: body.triggered_by ?? "manual",
        prompt_key: prov.prompt_key,
        prompt_version: prov.prompt_version,
        prompt_version_id: prov.prompt_version_id,
        model_version: prov.model_version ?? "gpt-4o-mini",
      }));
    }
    return c.json({ runs, mode });
  }
  const results = await runAllActive(c.env, predictorFor, { triggered_by: body.triggered_by ?? "manual", model_version: "heuristic:v1" });
  return c.json({ runs: results, mode });
});

mlRoute.post("/eval/load-bundled", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const r = await loadBundledDatasets(c.env);
  return c.json({ loaded: r });
});

mlRoute.get("/eval/gate", async (c) => {
  const threshold = Number(c.req.query("threshold") ?? "5");
  const report = await runRegressionGate(c.env, isFinite(threshold) ? threshold : 5);
  return c.json(report);
});

// Prompts
mlRoute.get("/prompts/:key", async (c) => {
  const key = c.req.param("key");
  const rows = await listPromptVersions(c.env, key);
  return c.json({ prompt_key: key, versions: rows });
});

mlRoute.get("/prompts/:key/active", async (c) => {
  const key = c.req.param("key");
  const salt = c.req.query("salt") ?? "";
  const p = await getPrompt(c.env, key, { salt });
  if (!p) return c.json({ error: "no_active_prompt" }, 404);
  return c.json(p);
});

mlRoute.post("/prompts/:key/promote", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const key = c.req.param("key");
  const b = (await c.req.json().catch(() => ({}))) as { version?: string; body?: string; model_hint?: string; notes?: string; rollout_pct?: number };
  if (!b.version || !b.body) return c.json({ error: "version_and_body_required" }, 400);
  const row = await promotePrompt(c.env, {
    prompt_key: key, version: b.version, body: b.body,
    model_hint: b.model_hint ?? null, notes: b.notes ?? null,
    rollout_pct: b.rollout_pct ?? 100, created_by: c.var.email,
  });
  return c.json({ promoted: row });
});

mlRoute.post("/prompts/:id/rollout", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as { rollout_pct?: number };
  if (typeof b.rollout_pct !== "number") return c.json({ error: "rollout_pct_required" }, 400);
  await setRolloutPct(c.env, id, b.rollout_pct);
  return c.json({ ok: true, id, rollout_pct: Math.max(0, Math.min(100, b.rollout_pct)) });
});

// Calibration
mlRoute.get("/calibration", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT prediction_type, day_bucket, sample_size, brier_score, log_loss,
            mean_predicted, mean_actual
       FROM prediction_outcomes_calibration
      ORDER BY prediction_type ASC, day_bucket DESC
      LIMIT 2000`,
  ).all();
  return c.json({ rows: r.results ?? [] });
});

mlRoute.get("/calibration/:type", async (c) => {
  const type = c.req.param("type");
  const r = await c.env.DB.prepare(
    `SELECT day_bucket, sample_size, brier_score, log_loss, mean_predicted, mean_actual
       FROM prediction_outcomes_calibration
      WHERE prediction_type = ?
      ORDER BY day_bucket DESC LIMIT 365`,
  ).bind(type).all();
  return c.json({ prediction_type: type, rows: r.results ?? [] });
});

mlRoute.post("/calibration/grade", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const r = await runCalibrationGrade(c.env);
  return c.json(r);
});

// Hallucination flags
mlRoute.get("/hallucinations", async (c) => {
  const reviewed = c.req.query("reviewed");
  const where = reviewed === "0" ? "WHERE reviewed = 0" : reviewed === "1" ? "WHERE reviewed = 1" : "";
  const r = await c.env.DB.prepare(
    `SELECT id, entity_id, predicate, claim_text, source_span, source_url,
            extractor, fail_reason, fuzzy_score, reviewed, reviewer_verdict, created_at
       FROM hallucination_flags ${where}
      ORDER BY created_at DESC LIMIT 200`,
  ).all();
  return c.json({ rows: r.results ?? [] });
});

mlRoute.post("/hallucinations/:id/review", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "admin_required" }, 403);
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as { verdict?: "true_hallucination" | "false_positive" | "unclear" };
  if (!b.verdict) return c.json({ error: "verdict_required" }, 400);
  await c.env.DB.prepare(
    `UPDATE hallucination_flags
        SET reviewed = 1, reviewer_email = ?, reviewer_verdict = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).bind(c.var.email, b.verdict, id).run();
  return c.json({ ok: true });
});

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
