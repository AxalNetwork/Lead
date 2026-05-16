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

export type ErrorKind =
  | "transient"
  | "permanent"
  | "config"
  | "auth"
  | "validation"
  | "upstream"
  | "internal";

// Closed enumeration of error codes the worker emits. New code paths must add
// to this union (the linter + reviewer flag string-literal codes that drift).
export type ErrCode =
  | "internal_error"
  | "not_found"
  | "validation_failed"
  | "bad_request"
  | "no_access_jwt"
  | "unauthorized"
  | "forbidden"
  | "no_email_claim"
  | "bad_aud"
  | "bad_iss"
  | "expired"
  | "scrape_blocked"
  | "robots_disallowed"
  | "tos_blocked"
  | "rate_limited"
  | "budget_exhausted"
  | "fetch.timeout"
  | "fetch.error"
  | "fetch.http_4xx"
  | "fetch.http_5xx"
  | "parse_error"
  | "json_parse_error"
  | "queue_malformed"
  | "queue_run_failed"
  | "queue_dead_letter"
  | "db_error"
  | "vectorize_error"
  | "ai_error"
  | "ai_budget_exhausted"
  | "workflow_failed"
  | "workflow_step_failed"
  | "config_missing"
  | "upstream_apollo"
  | "upstream_hunter"
  | "upstream_rocketreach"
  | "upstream_peopledatalabs"
  | "upstream_proxycurl"
  | "upstream_crunchbase"
  | "upstream_opencorporates"
  | "upstream_uk_ch"
  | "upstream_whoisxml"
  | "upstream_sec_edgar"
  | "upstream_brave"
  | "upstream_searx"
  | "upstream_browser"
  | "upstream_other";

/**
 * Runtime escape hatch for *constructed* codes (e.g. `upstream_${provider}`)
 * that aren't statically known. Use only at the boundary; prefer ErrCode
 * everywhere a literal can be used so the closed enum is enforceable by
 * tsc + eslint.
 */
export type RuntimeErrCode = ErrCode | (string & {});

export interface AppErrorJSON {
  error: ErrCode;
  code: ErrCode;
  kind: ErrorKind;
  status: number;
  message: string;
  retryable: boolean;
  context?: Record<string, unknown>;
  request_id?: string;
  cause?: { name: string; message: string; stack?: string };
}

export class AppError extends Error {
  readonly code: ErrCode;
  readonly kind: ErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  override readonly cause?: Error;

  constructor(opts: {
    code: ErrCode;
    kind: ErrorKind;
    status?: number;
    message?: string;
    retryable?: boolean;
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message ?? opts.code);
    this.name = "AppError";
    this.code = opts.code;
    this.kind = opts.kind;
    this.status = opts.status ?? defaultStatusForKind(opts.kind);
    this.retryable = opts.retryable ?? defaultRetryableForKind(opts.kind);
    this.context = opts.context ?? {};
    if (opts.cause instanceof Error) this.cause = opts.cause;
  }

  toJSON(requestId?: string): AppErrorJSON {
    const out: AppErrorJSON = {
      error: this.code,
      code: this.code,
      kind: this.kind,
      status: this.status,
      message: this.message,
      retryable: this.retryable,
    };
    if (Object.keys(this.context).length) out.context = this.context;
    if (requestId) out.request_id = requestId;
    if (this.cause) {
      const c: { name: string; message: string; stack?: string } = {
        name: this.cause.name,
        message: this.cause.message,
      };
      if (this.cause.stack) c.stack = this.cause.stack;
      out.cause = c;
    }
    return out;
  }
}

function defaultStatusForKind(kind: ErrorKind): number {
  switch (kind) {
    case "validation": return 400;
    case "auth": return 401;
    case "permanent": return 422;
    case "config": return 500;
    case "upstream": return 502;
    case "transient": return 503;
    case "internal":
    default: return 500;
  }
}

function defaultRetryableForKind(kind: ErrorKind): boolean {
  return kind === "transient" || kind === "upstream";
}

// ---- Common subclasses (sugar; AppError directly is also fine) ----------

export class ValidationError extends AppError {
  constructor(code: ErrCode, message: string, context?: Record<string, unknown>) {
    super({ code, kind: "validation", status: 400, message, retryable: false, ...(context ? { context } : {}) });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
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
  constructor(code: "no_access_jwt" | "unauthorized" | "forbidden" | "no_email_claim" | "bad_aud" | "bad_iss" | "expired", message?: string, context?: Record<string, unknown>) {
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
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    // Constructed at runtime; the closed ErrCode enum already enumerates
    // every known provider so this assertion is the only escape.
    const code = (`upstream_${provider}` as unknown) as ErrCode;
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
  constructor(host: string, reason: string, context?: Record<string, unknown>) {
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
  constructor(scope: string, context?: Record<string, unknown>) {
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
  constructor(code: ErrCode, message: string, context?: Record<string, unknown>) {
    super({ code, kind: "transient", status: 503, message, retryable: true, ...(context ? { context } : {}) });
    this.name = "TransientError";
  }
}

// ---- Wrappers --------------------------------------------------------------

/** Convert any unknown thrown value into an AppError (idempotent). */
export function wrapUnknown(e: unknown, code: ErrCode, context?: Record<string, unknown>): AppError {
  if (e instanceof AppError) {
    if (context) Object.assign(e.context, context);
    return e;
  }
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : safeJson(e));
  // Heuristic upgrade: detect common transient patterns from the cause.
  const guessed = classify(err);
  const opts: ConstructorParameters<typeof AppError>[0] = {
    code: guessed?.code ?? code,
    kind: guessed?.kind ?? "internal",
    message: err.message || code,
    cause: err,
  };
  if (guessed) opts.retryable = guessed.retryable;
  if (context) opts.context = context;
  return new AppError(opts);
}

/** Type guard. */
export function isAppError(e: unknown): e is AppError {
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
export function classify(err: unknown): { code: ErrCode; kind: ErrorKind; retryable: boolean } | null {
  if (err instanceof AppError) return { code: err.code, kind: err.kind, retryable: err.retryable };
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return null;

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
  if (msg.includes("gated_source_use_manual_paste") ||
      msg.includes("robots_disallowed") ||
      msg.includes("tos_blocked")) {
    return { code: "scrape_blocked", kind: "permanent", retryable: false };
  }
  if (msg.includes("no_table_found")) {
    return { code: "parse_error", kind: "validation", retryable: false };
  }
  if (msg.startsWith("fetch_failed:") || msg.includes(":fetch_failed:")) {
    // Generic fetch_failed without a more specific token → upstream/permanent.
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
    if (s === 429) return { code: "rate_limited", kind: "transient", retryable: true };
    if (s >= 500) return { code: "fetch.http_5xx", kind: "transient", retryable: true };
    if (s >= 400) return { code: "fetch.http_4xx", kind: "permanent", retryable: false };
  }

  // D1 / Vectorize / Workers AI.
  if (msg.includes("d1_error") || msg.includes("sqlite_") || msg.includes("database is locked")) {
    return { code: "db_error", kind: "transient", retryable: true };
  }
  if (msg.includes("vectorize")) return { code: "vectorize_error", kind: "upstream", retryable: true };
  if (msg.includes("ai.run") || msg.includes("workers ai")) return { code: "ai_error", kind: "upstream", retryable: true };

  // Parsing.
  if (msg.includes("unexpected token") || msg.includes("json")) return { code: "json_parse_error", kind: "validation", retryable: false };
  if (msg.includes("invalid url") || msg.includes("uri malformed")) return { code: "validation_failed", kind: "validation", retryable: false };

  // Auth.
  if (msg.includes("jwt") || msg.includes("unauthorized") || msg.includes("forbidden")) {
    return { code: "unauthorized", kind: "auth", retryable: false };
  }
  return null;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
