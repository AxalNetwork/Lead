// Task #27: structured error logging into D1.
//
// Best-effort writes — we never let a logging failure mask the original
// error. Truncation rules keep us under D1's 1MB row cap.

import type { Env } from "../types";
import { AppError, wrapUnknown } from "../errors";

const MAX_MSG = 2000;
const MAX_STACK = 8000;
const MAX_CONTEXT_JSON = 16000;

export interface LogErrorInput {
  err: unknown;
  request_id?: string | null;
  job_id?: string | null;
  step?: string | null;
  url?: string | null;
  method?: string | null;
}

function clip(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "…[clipped]" : s;
}

export async function logError(env: Env, input: LogErrorInput): Promise<number | null> {
  if (!env.DB) return null;
  const e = input.err instanceof AppError ? input.err : wrapUnknown(input.err, "internal");
  let contextJson: string | null = null;
  try {
    contextJson = clip(JSON.stringify(e.context ?? {}), MAX_CONTEXT_JSON);
  } catch { contextJson = null; }
  try {
    const r = await env.DB.prepare(
      `INSERT INTO error_log
        (request_id, job_id, step, code, kind, status, retryable, message, context_json,
         cause_name, cause_message, cause_stack, url, method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.request_id ?? null,
        input.job_id ?? null,
        input.step ?? null,
        e.code,
        e.kind,
        e.status,
        e.retryable ? 1 : 0,
        clip(e.message, MAX_MSG),
        contextJson,
        e.cause?.name ?? null,
        clip(e.cause?.message, MAX_MSG),
        clip(e.cause?.stack, MAX_STACK),
        input.url ?? null,
        input.method ?? null,
      )
      .run();
    const id = r.meta?.last_row_id;
    return typeof id === "number" ? id : null;
  } catch (logErr) {
    // Never throw from the logger.
    console.warn("error_log insert failed:", (logErr as Error).message);
    return null;
  }
}

export interface StepLogInput {
  job_id: string;
  step: string;
  status: "started" | "ok" | "warn" | "error" | "skipped";
  duration_ms?: number;
  count_in?: number;
  count_out?: number;
  error_id?: number | null;
  meta?: Record<string, unknown>;
}

export async function logStep(env: Env, input: StepLogInput): Promise<void> {
  if (!env.DB) return;
  let metaJson: string | null = null;
  try { metaJson = input.meta ? JSON.stringify(input.meta) : null; } catch { metaJson = null; }
  const finishedAt = input.status === "started" ? null : new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO workflow_step_log
        (job_id, step, status, finished_at, duration_ms, count_in, count_out, error_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.job_id,
        input.step,
        input.status,
        finishedAt,
        input.duration_ms ?? null,
        input.count_in ?? null,
        input.count_out ?? null,
        input.error_id ?? null,
        metaJson,
      )
      .run();
  } catch (e) {
    console.warn("workflow_step_log insert failed:", (e as Error).message);
  }
}

/** Convenience: time a function and log start+finish to workflow_step_log. */
export async function timedStep<T>(
  env: Env,
  job_id: string,
  step: string,
  fn: () => Promise<T>,
  opts: { count_in?: number; meta?: Record<string, unknown> } = {},
): Promise<T> {
  const t0 = Date.now();
  await logStep(env, { job_id, step, status: "started", count_in: opts.count_in, meta: opts.meta });
  try {
    const out = await fn();
    const count_out = Array.isArray(out) ? out.length : undefined;
    await logStep(env, { job_id, step, status: "ok", duration_ms: Date.now() - t0, count_in: opts.count_in, count_out, meta: opts.meta });
    return out;
  } catch (e) {
    const error_id = await logError(env, { err: e, job_id, step });
    await logStep(env, { job_id, step, status: "error", duration_ms: Date.now() - t0, count_in: opts.count_in, error_id, meta: opts.meta });
    throw e;
  }
}
