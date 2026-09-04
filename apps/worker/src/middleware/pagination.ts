// Bounded pagination guard for /api/*.
//
// ~30 list endpoints parse `limit` / `offset` with `Number(...)` and clamp
// only the upper bound (`Math.min(n, MAX)`). SQLite treats a negative LIMIT
// as "no limit", so `?limit=-1` dumped whole tables, and a non-numeric value
// became NaN → bound as NULL → `LIMIT NULL` → D1 datatype error → 500.
// Validating once here turns both into a 400 without touching every route:
// a pagination parameter, when present, must be a non-negative integer, and
// the page-size flavours must be at least 1. Valid input passes through
// unchanged, so per-route defaults and upper clamps keep working.

import type { MiddlewareHandler } from "hono";

const SIZE_PARAMS = ["limit", "page_size", "per_page"] as const;
const INDEX_PARAMS = ["offset", "page"] as const;
const INT_RE = /^\d{1,9}$/;

export interface PaginationProblem { param: string; value: string; message: string }

/** Pure validator: returns the first problem found, or null when every pagination param is acceptable. */
export function findPaginationProblem(params: URLSearchParams): PaginationProblem | null {
  for (const p of SIZE_PARAMS) {
    const v = params.get(p);
    if (v == null) continue;
    if (!INT_RE.test(v)) return { param: p, value: v, message: `${p} must be a positive integer` };
    if (Number(v) < 1) return { param: p, value: v, message: `${p} must be at least 1` };
  }
  for (const p of INDEX_PARAMS) {
    const v = params.get(p);
    if (v == null) continue;
    if (!INT_RE.test(v)) return { param: p, value: v, message: `${p} must be a non-negative integer` };
  }
  return null;
}

export const boundedPagination: MiddlewareHandler = async (c, next) => {
  const problem = findPaginationProblem(new URL(c.req.url).searchParams);
  if (problem) {
    return c.json({ error: "invalid_pagination", param: problem.param, message: problem.message }, 400);
  }
  await next();
};
