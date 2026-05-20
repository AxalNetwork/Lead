// Task #6: diligence run orchestrator.
//
// Surface:
//   createRun(env, opts)                       — synchronously inserts the
//                                                 diligence_runs row in
//                                                 status='queued' and returns
//                                                 {run_id, template_id,
//                                                 target_entity_id, check_keys}
//                                                 so the route handler can
//                                                 hand the run id back to the
//                                                 client immediately and kick
//                                                 off `executeRunLoop` via
//                                                 ctx.waitUntil for live UI
//                                                 progress.
//   executeRunLoop(env, plan)                  — iterates the check keys,
//                                                 calls executeCheck per key,
//                                                 bumps checks_completed +
//                                                 by_status_json on the run
//                                                 row AFTER EACH check so the
//                                                 UI's polling progress bar
//                                                 animates as the run
//                                                 progresses, then calls
//                                                 finalizeRun at the end.
//   startRun(env, opts)                        — convenience wrapper that
//                                                 awaits create + run (used
//                                                 by tests + the synchronous
//                                                 fallback path).
//   createRerunFailedPlan / rerunFailed        — analogous pair for rerun.
//
// Each check executor is invoked through `executeCheck`, which:
//   - times the executor,
//   - catches any thrown error and converts it to a `needs_human` row
//     (per the Task #14 honest-degradation pattern),
//   - persists one diligence_check_results row,
//   - mirrors any derived_facts through `insertFact` per the Task #1
//     canonical write contract (source_kind="enrichment",
//     source="diligence:<check_key>").
//
// `rerunFailed` creates a NEW diligence_runs row with parent_run_id set,
// then re-dispatches only the check_keys whose prior result was
// fail | caution | needs_human. Existing rows are NEVER mutated.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { REGISTRY, DEFAULT_TEMPLATE_KEYS } from "./registry";
import { computeOverallScore, tallyByStatus, isFailLike } from "./score";
import type { CheckContext, CheckResult, RunSummary, CheckStatus } from "./types";

export interface RunPlan {
  run_id: string;
  template_id: string;
  target_entity_id: string;
  triggered_by: string;
  check_keys: string[];
}

export async function loadTemplateKeys(env: Env, templateId: string): Promise<string[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT check_keys_json FROM diligence_templates WHERE id = ?`,
    ).bind(templateId).first<{ check_keys_json: string }>();
    if (!row) return null;
    const arr = JSON.parse(row.check_keys_json);
    return Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : null;
  } catch {
    return null;
  }
}

export async function ensureDefaultTemplate(env: Env): Promise<string> {
  const id = "tmpl_default";
  try {
    await env.DB.prepare(
      `INSERT INTO diligence_templates (id, name, description, owner_email, is_system, check_keys_json)
       VALUES (?, 'Default 50-point checklist', 'System-seeded default covering 9 sections', NULL, 1, ?)
       ON CONFLICT(id) DO UPDATE SET check_keys_json = excluded.check_keys_json, updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, JSON.stringify(DEFAULT_TEMPLATE_KEYS)).run();
  } catch (e) {
    console.warn("ensureDefaultTemplate failed", (e as Error).message);
  }
  return id;
}

async function persistResult(env: Env, runId: string, checkKey: string, result: CheckResult, def: { section: string; title: string }, durationMs: number): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO diligence_check_results
       (id, run_id, check_key, section, title, status, severity, confidence,
        finding_md, evidence_json, flagged_for_human, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, runId, checkKey, def.section, def.title,
    result.status, result.severity, result.confidence,
    result.finding_md, JSON.stringify(result.evidence ?? []),
    result.status === "needs_human" ? 1 : 0,
    durationMs,
  ).run();
}

async function mirrorDerivedFacts(env: Env, targetEntityId: string, checkKey: string, result: CheckResult): Promise<void> {
  if (!result.derived_facts || result.derived_facts.length === 0) return;
  // Only mirror facts when the check actually produced a verdict; needs_human / n/a are not facts.
  if (result.status !== "pass" && result.status !== "fail" && result.status !== "caution") return;
  for (const df of result.derived_facts) {
    try {
      await insertFact(env, {
        entity_id: targetEntityId,
        predicate: df.predicate,
        value_text: df.value_text ?? null,
        value_number: df.value_number ?? null,
        value_json: df.value_json ?? null,
        source_kind: "enrichment",
        source: `diligence:${checkKey}`,
        confidence: df.confidence ?? result.confidence,
      });
    } catch (e) {
      console.warn("diligence insertFact failed", checkKey, df.predicate, (e as Error).message);
    }
  }
}

// Per-check progress write: bumps checks_completed + by_status_json on the
// run row so a UI polling GET /api/diligence/runs/:id sees the bar advance.
// Best-effort: a transient failure must NOT abort the run.
async function bumpProgress(env: Env, runId: string): Promise<void> {
  try {
    const tally = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM diligence_check_results WHERE run_id = ? GROUP BY status`,
    ).bind(runId).all<{ status: CheckStatus; n: number }>();
    const by: Record<string, number> = { pass: 0, fail: 0, caution: 0, "n/a": 0, needs_human: 0 };
    let completed = 0;
    for (const row of tally.results ?? []) {
      by[row.status] = row.n;
      completed += row.n;
    }
    await env.DB.prepare(
      `UPDATE diligence_runs SET status = 'running', checks_completed = ?, by_status_json = ? WHERE id = ?`,
    ).bind(completed, JSON.stringify(by), runId).run();
  } catch (e) {
    console.warn("diligence bumpProgress failed", runId, (e as Error).message);
  }
}

export async function executeCheck(env: Env, runId: string, ctx: CheckContext, checkKey: string): Promise<CheckResult> {
  const def = REGISTRY.get(checkKey);
  if (!def) {
    const result: CheckResult = {
      status: "needs_human",
      severity: "medium",
      confidence: 0,
      finding_md: `Check key \`${checkKey}\` is not registered. Skipped.`,
      evidence: [],
      reason: "check_key_not_registered",
    };
    await persistResult(env, runId, checkKey, result, { section: "corporate", title: checkKey }, 0);
    await bumpProgress(env, runId);
    return result;
  }
  const start = Date.now();
  let result: CheckResult;
  try {
    result = await def.run.call(def, ctx);
  } catch (e) {
    result = {
      status: "needs_human",
      severity: def.severity,
      confidence: 0,
      finding_md: `**${def.title}** — check threw: \`${(e as Error).message}\`. Flagged for human review.`,
      evidence: [],
      reason: "executor_threw",
    };
  }
  const durationMs = Date.now() - start;
  await persistResult(env, runId, checkKey, result, { section: def.section, title: def.title }, durationMs);
  await mirrorDerivedFacts(env, ctx.target_entity_id, checkKey, result);
  await bumpProgress(env, runId);
  return result;
}

async function finalizeRun(env: Env, runId: string, results: CheckResult[], total: number): Promise<RunSummary> {
  const scored = results.map((r) => ({ status: r.status, severity: r.severity }));
  const overall = computeOverallScore(scored);
  const by = tallyByStatus(scored);
  await env.DB.prepare(
    `UPDATE diligence_runs
        SET status = 'completed', overall_score = ?, checks_total = ?, checks_completed = ?,
            by_status_json = ?, finished_at = datetime('now')
      WHERE id = ?`,
  ).bind(overall, total, results.length, JSON.stringify(by), runId).run();
  return { run_id: runId, status: "completed", overall_score: overall, checks_total: total, checks_completed: results.length, by_status: by };
}

// Synchronously creates the run row in status='queued' and returns the plan.
// The route handler can return run_id immediately to the client and dispatch
// `executeRunLoop(env, plan)` via ctx.waitUntil for the heavy work.
export async function createRun(env: Env, opts: { template_id: string; target_entity_id: string; triggered_by: string }): Promise<RunPlan> {
  const run_id = crypto.randomUUID();
  const check_keys = (await loadTemplateKeys(env, opts.template_id)) ?? DEFAULT_TEMPLATE_KEYS;
  const seedBy = JSON.stringify({ pass: 0, fail: 0, caution: 0, "n/a": 0, needs_human: 0 });
  await env.DB.prepare(
    `INSERT INTO diligence_runs (id, template_id, target_entity_id, triggered_by, status, checks_total, by_status_json, started_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, datetime('now'))`,
  ).bind(run_id, opts.template_id, opts.target_entity_id, opts.triggered_by, check_keys.length, seedBy).run();
  return { run_id, template_id: opts.template_id, target_entity_id: opts.target_entity_id, triggered_by: opts.triggered_by, check_keys };
}

// Heavy-work loop. Marks the run 'running' on entry, persists progress
// after each check (via executeCheck → bumpProgress), and finalizes the
// row on completion.
export async function executeRunLoop(env: Env, plan: RunPlan): Promise<RunSummary> {
  await env.DB.prepare(
    `UPDATE diligence_runs SET status = 'running' WHERE id = ?`,
  ).bind(plan.run_id).run().catch(() => undefined);
  const ctx: CheckContext = { env, target_entity_id: plan.target_entity_id, triggered_by: plan.triggered_by };
  const results: CheckResult[] = [];
  for (const key of plan.check_keys) {
    const r = await executeCheck(env, plan.run_id, ctx, key);
    results.push(r);
  }
  return finalizeRun(env, plan.run_id, results, plan.check_keys.length);
}

// Convenience wrapper: awaits create + run synchronously. Used by tests
// and by callers that don't have a waitUntil-capable execution context.
export async function startRun(env: Env, opts: { template_id: string; target_entity_id: string; triggered_by: string }): Promise<RunSummary> {
  const plan = await createRun(env, opts);
  return executeRunLoop(env, plan);
}

// Build a rerun plan: looks up the parent's fail-like check_keys and creates
// a new diligence_runs row with parent_run_id pointing back. Returns null if
// the parent doesn't exist or there's nothing to re-dispatch.
export async function createRerunFailedPlan(env: Env, opts: { parent_run_id: string; triggered_by: string }): Promise<RunPlan | null> {
  const parent = await env.DB.prepare(
    `SELECT id, template_id, target_entity_id, triggered_by FROM diligence_runs WHERE id = ?`,
  ).bind(opts.parent_run_id).first<{ id: string; template_id: string; target_entity_id: string; triggered_by: string }>();
  if (!parent) return null;
  const prior = await env.DB.prepare(
    `SELECT check_key, status FROM diligence_check_results WHERE run_id = ?`,
  ).bind(opts.parent_run_id).all<{ check_key: string; status: CheckStatus }>();
  const failedKeys = (prior.results ?? []).filter((r) => isFailLike({ status: r.status })).map((r) => r.check_key);
  if (failedKeys.length === 0) return null;

  const run_id = crypto.randomUUID();
  const seedBy = JSON.stringify({ pass: 0, fail: 0, caution: 0, "n/a": 0, needs_human: 0 });
  await env.DB.prepare(
    `INSERT INTO diligence_runs (id, template_id, target_entity_id, triggered_by, status, checks_total, by_status_json, parent_run_id, started_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, datetime('now'))`,
  ).bind(run_id, parent.template_id, parent.target_entity_id, opts.triggered_by, failedKeys.length, seedBy, parent.id).run();
  return { run_id, template_id: parent.template_id, target_entity_id: parent.target_entity_id, triggered_by: opts.triggered_by, check_keys: failedKeys };
}

export async function rerunFailed(env: Env, opts: { parent_run_id: string; triggered_by: string }): Promise<RunSummary | null> {
  const plan = await createRerunFailedPlan(env, opts);
  if (!plan) return null;
  return executeRunLoop(env, plan);
}
