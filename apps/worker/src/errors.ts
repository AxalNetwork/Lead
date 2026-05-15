// Centralized error taxonomy for the worker (Task #27).
//
// Every operational failure should be either:
//   1. an `AppError` subclass thrown explicitly, OR
//   2. caught and re-thrown via `wrapUnknown(e, code, ctx)` so the global
//      onError handler in `index.ts` can serialize it to JSON, log it to
//      `error_log`, and (where applicable) attach a request_id.
//
// All AppErrors carry:
//   - code:   stable machine string (snake_case, e.g. "scrape_blocked").
//   - status: HTTP status to return when surfaced via API.
//   - kind:   high-level category for UI grouping ("transient"|"permanent"|"config"|"auth"|"validation"|"upstream"|"internal").
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

export interface AppErrorJSON {
  error: string;
  code: string;
  kind: ErrorKind;
  status: number;
  message: string;
  retryable: boolean;
  context?: Record<string, unknown>;
  request_id?: string;
  cause?: { name: string; message: string; stack?: string };
}

export class AppError extends Error {
  readonly code: string;
  readonly kind: ErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  readonly cause?: Error;

  constructor(opts: {
    code: string;
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
      out.cause = {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack,
      };
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
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super({ code, kind: "validation", status: 400, message, retryable: false, context });
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
      context,
    });
    this.name = "AuthError";
  }
}

export class UpstreamError extends AppError {
  constructor(provider: string, message: string, context?: Record<string, unknown>) {
    super({
      code: `upstream_${provider}`,
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
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super({ code, kind: "transient", status: 503, message, retryable: true, context });
    this.name = "TransientError";
  }
}

// ---- Wrappers --------------------------------------------------------------

/** Convert any unknown thrown value into an AppError (idempotent). */
export function wrapUnknown(e: unknown, code: string, context?: Record<string, unknown>): AppError {
  if (e instanceof AppError) {
    if (context) Object.assign(e.context, context);
    return e;
  }
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e));
  return new AppError({
    code,
    kind: "internal",
    message: err.message || code,
    context,
    cause: err,
  });
}

/** Type guard. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
