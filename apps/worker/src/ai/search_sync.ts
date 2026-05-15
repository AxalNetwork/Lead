// AI Search namespace sync (Task #25 step 8).
//
// Keeps the `axal-profiles` AI Search namespace in sync with leads, firms,
// and companies. Called from inside the EntityLock DO after every merge.
// Skeleton: writes to the AI_SEARCH Fetcher binding when present; falls
// back to a no-op (with one D1 row in `ai_search_pending`) so the docs can
// be backfilled later.

import type { Env } from "../types";

export interface SearchDoc {
  id: string;
  type: "lead" | "firm" | "company" | "account";
  title: string;
  body: string;
  url?: string;
  /**
   * Override the AI Search namespace for this single doc. Accounts (Task #44)
   * route to `axal-accounts` so prospect search doesn't blend with the
   * investor/firm/company `axal-profiles` namespace.
   */
  namespace?: string;
}

const TYPE_NAMESPACE: Partial<Record<SearchDoc["type"], string>> = {
  account: "axal-accounts",
};

export async function indexEntity(env: Env, doc: SearchDoc): Promise<void> {
  const ns = doc.namespace ?? TYPE_NAMESPACE[doc.type] ?? env.AI_SEARCH_NAMESPACE ?? "axal-profiles";
  if (env.AI_SEARCH) {
    try {
      await env.AI_SEARCH.fetch(`https://ai-search/${encodeURIComponent(ns)}/documents`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...doc, id: `${doc.type}:${doc.id}` }),
      });
      return;
    } catch (e) {
      console.warn("ai-search index failed", (e as Error).message);
    }
  }
  // Defer: queue a row for later backfill.
  try {
    await env.DB.prepare(
      `INSERT INTO ai_search_pending (id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
    ).bind(`${doc.type}:${doc.id}`, doc.type, JSON.stringify(doc), new Date().toISOString()).run();
  } catch { /* table may not exist yet */ }
}
