// Task #4: shared try/catch wrapper for optional source tables.
// Returns an empty result set on any error (missing table, schema drift,
// transient D1 issue) so extractors degrade to 0 proposals instead of
// throwing. Per the Task #14 verification optional-source pattern.

import type { Env } from "../../types";

export async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    const msg = (e as Error).message || "";
    // Only swallow schema-related noise; surface other failures.
    if (/no such table|no such column|no such index/i.test(msg)) return [];
    console.warn("relationships safeAll error", msg);
    return [];
  }
}
