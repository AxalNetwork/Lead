// Task #27: structured error logging into D1 + Analytics Engine mirror.
//
// Best-effort writes — we never let a logging failure mask the original
// error. Truncation rules keep us under D1's 1MB row cap. Every call also
// emits one Analytics Engine data point so spike detection / alerting can
// be done without scanning D1.

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
  workflow_run_id?: string | null;
  host?: string | null;
  user_email?: string | null;
  retry_count?: number | null;
}

function clip(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "…[clipped]" : s;
}

function hostFromUrl(u?: string | null): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

export async function logError(env: Env, input: LogErrorInput): Promise<number | null> {
  const e = input.err instanceof AppError ? input.err : wrapUnknown(input.err, "internal_error");
  const host = input.host ?? hostFromUrl(input.url);

  // Mirror to Analytics Engine first (cheap, doesn't depend on D1).
  try {
    if (env.ANALYTICS) {
      env.ANALYTICS.writeDataPoint({
        indexes: [e.code],
        blobs: [
          e.kind,
          e.code,
          input.step ?? "",
          input.job_id ?? "",
          input.request_id ?? "",
          host ?? "",
          input.workflow_run_id ?? "",
          input.user_email ?? "",
        ],
        doubles: [e.status, e.retryable ? 1 : 0, input.retry_count ?? 0],
      });
    }
  } catch { /* never throw from logger */ }

  if (!env.DB) return null;
  let contextJson: string | null = null;
  try { contextJson = clip(JSON.stringify(e.context ?? {}), MAX_CONTEXT_JSON); } catch { contextJson = null; }
  try {
    const r = await env.DB.prepare(
      `INSERT INTO error_log
        (request_id, job_id, step, code, kind, status, retryable, message, context_json,
         cause_name, cause_message, cause_stack, url, method,
         workflow_run_id, host, user_email, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.workflow_run_id ?? null,
        host,
        input.user_email ?? null,
        input.retry_count ?? 0,
      )
      .run();
    const id = r.meta?.last_row_id;
    return typeof id === "number" ? id : null;
  } catch (logErr) {
    // Never throw from the logger.
    // Telemetry-of-telemetry: never throw, never log to console (CI gate).
    void logErr;
    return null;
  }
}

export interface StepLogInput {
  job_id: string;
  step: string;
  status: "started" | "ok" | "warn" | "error" | "skipped";
  duration_ms?: number | undefined;
  count_in?: number | undefined;
  count_out?: number | undefined;
  error_id?: number | null | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Cloudflare Workflows run id (or queue batch id). */
  workflow_run_id?: string | undefined;
  /** 1-based attempt counter for the step (defaults to 1). */
  attempt?: number | undefined;
  /** Denormalized ErrCode for fast cluster queries when status='error'. */
  error_code?: string | undefined;
}

export async function logStep(env: Env, input: StepLogInput): Promise<void> {
  if (!env.DB) return;
  let metaJson: string | null = null;
  try { metaJson = input.meta ? JSON.stringify(input.meta) : null; } catch { metaJson = null; }
  const finishedAt = input.status === "started" ? null : new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO workflow_step_log
        (job_id, step, step_name, status, finished_at, duration_ms, count_in, count_out, error_id, meta_json, workflow_run_id, attempt, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.job_id,
        input.step,
        input.step,
        input.status,
        finishedAt,
        input.duration_ms ?? null,
        input.count_in ?? null,
        input.count_out ?? null,
        input.error_id ?? null,
        metaJson,
        input.workflow_run_id ?? null,
        input.attempt ?? 1,
        input.error_code ?? null,
      )
      .run();
  } catch (e) {
    void e;
  }
}

/** Convenience: time a function and log start+finish to workflow_step_log. */
export async function timedStep<T>(
  env: Env,
  job_id: string,
  step: string,
  fn: () => Promise<T>,
  opts: { count_in?: number; meta?: Record<string, unknown>; workflow_run_id?: string; attempt?: number } = {},
): Promise<T> {
  const t0 = Date.now();
  const { workflow_run_id, attempt } = opts;
  await logStep(env, { job_id, step, status: "started", count_in: opts.count_in, meta: opts.meta, workflow_run_id, attempt });
  try {
    const out = await fn();
    const count_out = Array.isArray(out) ? out.length : undefined;
    await logStep(env, { job_id, step, status: "ok", duration_ms: Date.now() - t0, count_in: opts.count_in, count_out, meta: opts.meta, workflow_run_id, attempt });
    return out;
  } catch (e) {
    const error_id = await logError(env, { err: e, job_id, step });
    const { classify } = await import("../errors.js");
    const cls = classify(e);
    await logStep(env, { job_id, step, status: "error", duration_ms: Date.now() - t0, count_in: opts.count_in, error_id, meta: opts.meta, workflow_run_id, attempt, error_code: cls?.code });
    throw e;
  }
}
