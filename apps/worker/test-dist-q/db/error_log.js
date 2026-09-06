// Task #27: structured error logging into D1 + Analytics Engine mirror.
//
// Best-effort writes — we never let a logging failure mask the original
// error. Truncation rules keep us under D1's 1MB row cap. Every call also
// emits one Analytics Engine data point so spike detection / alerting can
// be done without scanning D1.
import { AppError, wrapUnknown } from "../errors";
const MAX_MSG = 2000;
const MAX_STACK = 8000;
const MAX_CONTEXT_JSON = 16000;
function clip(s, max) {
    if (!s)
        return null;
    return s.length > max ? s.slice(0, max) + "…[clipped]" : s;
}
function hostFromUrl(u) {
    if (!u)
        return null;
    try {
        return new URL(u).hostname.toLowerCase();
    }
    catch {
        return null;
    }
}
export async function logError(env, input) {
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
    }
    catch { /* never throw from logger */ }
    if (!env.DB)
        return null;
    let contextJson = null;
    try {
        contextJson = clip(JSON.stringify(e.context ?? {}), MAX_CONTEXT_JSON);
    }
    catch {
        contextJson = null;
    }
    try {
        const r = await env.DB.prepare(`INSERT INTO error_log
        (request_id, job_id, step, code, kind, status, retryable, message, context_json,
         cause_name, cause_message, cause_stack, url, method,
         workflow_run_id, host, user_email, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(input.request_id ?? null, input.job_id ?? null, input.step ?? null, e.code, e.kind, e.status, e.retryable ? 1 : 0, clip(e.message, MAX_MSG), contextJson, e.cause?.name ?? null, clip(e.cause?.message, MAX_MSG), clip(e.cause?.stack, MAX_STACK), input.url ?? null, input.method ?? null, input.workflow_run_id ?? null, host, input.user_email ?? null, input.retry_count ?? 0)
            .run();
        const id = r.meta?.last_row_id;
        return typeof id === "number" ? id : null;
    }
    catch (logErr) {
        // Never throw from the logger.
        // Telemetry-of-telemetry: never throw, never log to console (CI gate).
        void logErr;
        return null;
    }
}
export async function logStep(env, input) {
    if (!env.DB)
        return;
    let metaJson = null;
    try {
        metaJson = input.meta ? JSON.stringify(input.meta) : null;
    }
    catch {
        metaJson = null;
    }
    const finishedAt = input.status === "started" ? null : new Date().toISOString();
    try {
        await env.DB.prepare(`INSERT INTO workflow_step_log
        (job_id, step, step_name, status, finished_at, duration_ms, count_in, count_out, error_id, meta_json, workflow_run_id, attempt, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(input.job_id, input.step, input.step, input.status, finishedAt, input.duration_ms ?? null, input.count_in ?? null, input.count_out ?? null, input.error_id ?? null, metaJson, input.workflow_run_id ?? null, input.attempt ?? 1, input.error_code ?? null)
            .run();
    }
    catch (e) {
        void e;
    }
}
/** Convenience: time a function and log start+finish to workflow_step_log. */
export async function timedStep(env, job_id, step, fn, opts = {}) {
    const t0 = Date.now();
    const { workflow_run_id, attempt } = opts;
    await logStep(env, { job_id, step, status: "started", count_in: opts.count_in, meta: opts.meta, workflow_run_id, attempt });
    try {
        const out = await fn();
        const count_out = Array.isArray(out) ? out.length : undefined;
        await logStep(env, { job_id, step, status: "ok", duration_ms: Date.now() - t0, count_in: opts.count_in, count_out, meta: opts.meta, workflow_run_id, attempt });
        return out;
    }
    catch (e) {
        const { classify, isBenignSkip } = await import("../errors.js");
        // Task #72: robots.txt / ToS blocks are benign policy skips, not errors.
        // Don't write an error_log row (it would surface as a red 422 in the
        // operator console) — record the step as `skipped` instead and rethrow so
        // the caller routes the job to the `skipped` terminal status.
        const skip = isBenignSkip(e);
        if (skip) {
            await logStep(env, { job_id, step, status: "skipped", duration_ms: Date.now() - t0, count_in: opts.count_in, meta: opts.meta, workflow_run_id, attempt, error_code: skip.skip_code });
            throw e;
        }
        const error_id = await logError(env, { err: e, job_id, step });
        const cls = classify(e);
        await logStep(env, { job_id, step, status: "error", duration_ms: Date.now() - t0, count_in: opts.count_in, error_id, meta: opts.meta, workflow_run_id, attempt, error_code: cls?.code });
        throw e;
    }
}
