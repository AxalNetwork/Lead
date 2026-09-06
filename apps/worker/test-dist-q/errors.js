// Centralized error taxonomy for the worker (Task #27).
//
// Every operational failure should be either:
//   1. an `AppError` subclass thrown explicitly, OR
//   2. caught and re-thrown via `wrapUnknown(e, code, ctx)` so the global
//      onError handler in `index.ts` can serialize it to JSON, log it to
//      `error_log`, mirror it to Analytics Engine, and attach a request_id.
//
// All AppErrors carry:
//   - code:   stable machine string from the ErrCode union below.
//   - status: HTTP status to return when surfaced via API.
//   - kind:   high-level category for UI grouping.
//   - retryable: hint to the queue/retry layer.
//   - context: free-form structured context (job_id, url, host, provider…).
export class AppError extends Error {
    code;
    kind;
    status;
    retryable;
    context;
    cause;
    constructor(opts) {
        super(opts.message ?? opts.code);
        this.name = "AppError";
        this.code = opts.code;
        this.kind = opts.kind;
        this.status = opts.status ?? defaultStatusForKind(opts.kind);
        this.retryable = opts.retryable ?? defaultRetryableForKind(opts.kind);
        this.context = opts.context ?? {};
        if (opts.cause instanceof Error)
            this.cause = opts.cause;
    }
    toJSON(requestId) {
        const out = {
            error: this.code,
            code: this.code,
            kind: this.kind,
            status: this.status,
            message: this.message,
            retryable: this.retryable,
        };
        if (Object.keys(this.context).length)
            out.context = this.context;
        if (requestId)
            out.request_id = requestId;
        if (this.cause) {
            const c = {
                name: this.cause.name,
                message: this.cause.message,
            };
            if (this.cause.stack)
                c.stack = this.cause.stack;
            out.cause = c;
        }
        return out;
    }
}
function defaultStatusForKind(kind) {
    switch (kind) {
        case "validation": return 400;
        case "auth": return 401;
        case "permanent": return 422;
        case "config": return 500;
        case "upstream": return 502;
        case "transient": return 503;
        // Task #72: a benign skip is not an error surface — neutral 200.
        case "skip": return 200;
        case "internal":
        default: return 500;
    }
}
function defaultRetryableForKind(kind) {
    return kind === "transient" || kind === "upstream";
}
// ---- Common subclasses (sugar; AppError directly is also fine) ----------
export class ValidationError extends AppError {
    constructor(code, message, context) {
        super({ code, kind: "validation", status: 400, message, retryable: false, ...(context ? { context } : {}) });
        this.name = "ValidationError";
    }
}
export class NotFoundError extends AppError {
    constructor(resource, id) {
        super({
            code: "not_found",
            kind: "permanent",
            status: 404,
            message: `${resource}${id ? ` ${id}` : ""} not found`,
            retryable: false,
            context: id ? { resource, id } : { resource },
        });
        this.name = "NotFoundError";
    }
}
export class AuthError extends AppError {
    constructor(code, message, context) {
        super({
            code,
            kind: "auth",
            status: code === "forbidden" ? 403 : 401,
            message: message ?? code,
            retryable: false,
            ...(context ? { context } : {}),
        });
        this.name = "AuthError";
    }
}
export class UpstreamError extends AppError {
    constructor(provider, message, context) {
        // Constructed at runtime; the closed ErrCode enum already enumerates
        // every known provider so this assertion is the only escape.
        const code = `upstream_${provider}`;
        super({
            code,
            kind: "upstream",
            status: 502,
            message,
            retryable: true,
            context: { provider, ...(context ?? {}) },
        });
        this.name = "UpstreamError";
    }
}
export class ScrapeBlockedError extends AppError {
    constructor(host, reason, context) {
        super({
            code: "scrape_blocked",
            kind: "permanent",
            status: 403,
            message: `${host}: ${reason}`,
            retryable: false,
            context: { host, reason, ...(context ?? {}) },
        });
        this.name = "ScrapeBlockedError";
    }
}
export class BudgetExhaustedError extends AppError {
    constructor(scope, context) {
        super({
            code: "budget_exhausted",
            kind: "permanent",
            status: 429,
            message: `Budget exhausted for ${scope}`,
            retryable: false,
            context: { scope, ...(context ?? {}) },
        });
        this.name = "BudgetExhaustedError";
    }
}
export class TransientError extends AppError {
    constructor(code, message, context) {
        super({ code, kind: "transient", status: 503, message, retryable: true, ...(context ? { context } : {}) });
        this.name = "TransientError";
    }
}
// ---- Wrappers --------------------------------------------------------------
/** Convert any unknown thrown value into an AppError (idempotent). */
export function wrapUnknown(e, code, context) {
    if (e instanceof AppError) {
        if (context)
            Object.assign(e.context, context);
        return e;
    }
    const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : safeJson(e));
    // Heuristic upgrade: detect common transient patterns from the cause.
    const guessed = classify(err);
    const opts = {
        code: guessed?.code ?? code,
        kind: guessed?.kind ?? "internal",
        message: err.message || code,
        cause: err,
    };
    if (guessed)
        opts.retryable = guessed.retryable;
    if (context)
        opts.context = context;
    return new AppError(opts);
}
/** Type guard. */
export function isAppError(e) {
    return e instanceof AppError;
}
/**
 * Heuristic classifier for stringly-typed errors thrown by the existing
 * codebase or by the platform (D1, fetch, Workers AI). Returns null if no
 * pattern matches; callers should then use the supplied default code/kind.
 *
 * Required by Task #27 acceptance: every logged failure has a well-typed
 * code, even when thrown deep in legacy code that hasn't migrated to
 * AppError yet.
 */
export function classify(err) {
    if (err instanceof AppError)
        return { code: err.code, kind: err.kind, retryable: err.retryable };
    const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
    if (!msg)
        return null;
    // Task #70: Cloudflare's per-invocation subrequest cap surfaces as
    // "Too many subrequests by single Worker invocation", which bubbles up
    // wrapped in a `fetch_failed:proxy_error:...` (or `fetch_error:...`)
    // string. This is NOT a permanent scrape block — the page is fine, the
    // invocation just ran out of budget — so it must be classified
    // transient/retryable AHEAD of the generic `fetch_failed:` permanent
    // rule below. Matched specifically (not all proxy_errors) so genuine
    // upstream proxy failures still dead-letter as before.
    //
    // `subrequest_budget_exhausted` is our OWN pre-emptive refusal (the
    // crawl-path budget stopped a fetch before it could trip the platform
    // cap); it is the same condition and must retry identically.
    if (msg.includes("too many subrequests") || msg.includes("subrequest_budget")) {
        return { code: "subrequest_limit", kind: "transient", retryable: true };
    }
    // Pipeline-level fetch/scrape sentinels. These reasons are bubbled up
    // from the scraper as plain `Error("fetch_failed:<reason>:status=<n>")`
    // (see scraper/pipeline.ts). They are expected operational outcomes —
    // not real internal errors — so we map them to typed codes the queue
    // can dead-letter without paging.
    if (msg.includes("scraping_api_not_configured") ||
        msg.includes("proxy_not_configured") ||
        msg.includes("browser_binding_unavailable") ||
        msg.includes("puppeteer_module_missing")) {
        return { code: "config_missing", kind: "config", retryable: false };
    }
    // Task #72: robots.txt / ToS blocks are EXPECTED, benign policy outcomes,
    // not internal errors — honoring a host's robots.txt is correct behavior.
    // Classify them as the `skip` kind so the queue routes them to the `skipped`
    // terminal status (no error_log row, never retried) instead of failing /
    // dead-lettering them as scrape errors. NB: the scraper emits the token
    // `robots_disallow` (see scraper/robots.ts); the old code only matched the
    // `robots_disallowed` spelling and silently fell through to the generic
    // fetch_failed → permanent rule, so the block surfaced as a red 422.
    if (msg.includes("robots_disallow") || msg.includes("tos_blocked")) {
        const code = msg.includes("tos_blocked") ? "tos_blocked" : "robots_disallowed";
        return { code, kind: "skip", retryable: false };
    }
    // Gated sources still need an operator manual-paste; that's a permanent
    // scrape block (the queue preflight already skips it earlier — this is the
    // fetcher backstop, kept permanent so its behavior is unchanged).
    if (msg.includes("gated_source_use_manual_paste")) {
        return { code: "scrape_blocked", kind: "permanent", retryable: false };
    }
    if (msg.includes("no_table_found")) {
        return { code: "parse_error", kind: "validation", retryable: false };
    }
    if (msg.startsWith("fetch_failed:") || msg.includes(":fetch_failed:")) {
        // Task #71: a `fetch_failed:` message can carry an embedded upstream HTTP
        // status (e.g. "fetch_failed:status_429:status=429"). A 429 rate-limit and
        // any 5xx are TRANSIENT — the page is fine, the upstream is just briefly
        // refusing — so they must retry with backoff, not get dropped as a
        // permanent scrape block on attempt 1. Parse the embedded status BEFORE the
        // generic permanent fallback. A genuine 4xx (403/404/...) or a
        // fetch_failed with no recoverable status still resolves to permanent
        // scrape_blocked (prior behavior preserved). The dedicated scrape sentinels
        // (robots/tos/gated/config) matched above stay permanent regardless.
        const embedded = msg.match(/status[_=: ]\s*(\d{3})/) ?? msg.match(/\b(4\d{2}|5\d{2})\b/);
        if (embedded) {
            const s = Number(embedded[1]);
            if (s === 429)
                return { code: "rate_limited", kind: "transient", retryable: true };
            if (s >= 500)
                return { code: "fetch.http_5xx", kind: "transient", retryable: true };
        }
        // Generic fetch_failed without a recoverable status → upstream/permanent.
        return { code: "scrape_blocked", kind: "permanent", retryable: false };
    }
    // Network / fetch.
    if (msg.includes("aborted") || msg.includes("timeout") || msg.includes("timed out")) {
        return { code: "fetch.timeout", kind: "transient", retryable: true };
    }
    if (msg.includes("network connection lost") || msg.includes("econnreset") || msg.includes("ehostunreach")) {
        return { code: "fetch.error", kind: "transient", retryable: true };
    }
    // HTTP status codes embedded in the message (e.g. "status_503", "status=404",
    // "status: 502", or a bare " 404 " token).
    const statusMatch = msg.match(/status[_=: ]\s*(\d{3})/) ?? msg.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusMatch) {
        const s = Number(statusMatch[1]);
        if (s === 429)
            return { code: "rate_limited", kind: "transient", retryable: true };
        if (s >= 500)
            return { code: "fetch.http_5xx", kind: "transient", retryable: true };
        if (s >= 400)
            return { code: "fetch.http_4xx", kind: "permanent", retryable: false };
    }
    // D1 / Vectorize / Workers AI.
    if (msg.includes("d1_error") || msg.includes("sqlite_") || msg.includes("database is locked")) {
        return { code: "db_error", kind: "transient", retryable: true };
    }
    if (msg.includes("vectorize"))
        return { code: "vectorize_error", kind: "upstream", retryable: true };
    if (msg.includes("ai.run") || msg.includes("workers ai"))
        return { code: "ai_error", kind: "upstream", retryable: true };
    // Parsing.
    if (msg.includes("unexpected token") || msg.includes("json"))
        return { code: "json_parse_error", kind: "validation", retryable: false };
    if (msg.includes("invalid url") || msg.includes("uri malformed"))
        return { code: "validation_failed", kind: "validation", retryable: false };
    // Auth.
    if (msg.includes("jwt") || msg.includes("unauthorized") || msg.includes("forbidden")) {
        return { code: "unauthorized", kind: "auth", retryable: false };
    }
    return null;
}
/**
 * Task #72: is this thrown value a benign policy skip (robots.txt / ToS)
 * rather than a real fetch failure? Benign skips end a job in the `skipped`
 * terminal status (no error_log, no retry), NOT failed/dead_letter. Returns
 * the stable `skip_code` + a human reason, or null for everything else (which
 * the caller then classifies / retries / dead-letters normally).
 */
export function isBenignSkip(err) {
    const cls = err instanceof AppError
        ? { code: err.code, kind: err.kind }
        : classify(err);
    if (!cls || cls.kind !== "skip")
        return null;
    const skip_code = cls.code === "tos_blocked" ? "tos_blocked" : "robots_disallow";
    const reason = err instanceof Error ? err.message : String(err ?? skip_code);
    return { skip_code, reason };
}
function safeJson(v) {
    try {
        return JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}
