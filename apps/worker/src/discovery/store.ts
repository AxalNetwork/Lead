// Persists discovery candidate rows; the unique index on (firm_domain, url)
// keeps repeated runs idempotent.

import type { CandidateInput } from "./discover";

export async function saveCandidates(
  db: D1Database,
  jobId: string | null,
  rows: CandidateInput[],
): Promise<number> {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO discovery_candidates
           (id, job_id, firm_domain, query, source, url, title, snippet, name, org, persona_role, status, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        jobId,
        // SQLite unique indexes don't collide on NULLs; use a sentinel for
        // persona-mode rows so repeated discovery runs stay idempotent.
        r.firm_domain ?? "__persona__",
        r.query,
        r.source,
        r.url,
        r.title.slice(0, 500),
        r.snippet.slice(0, 1000),
        r.name ?? null,
        r.org ?? null,
        r.persona_role ?? null,
        JSON.stringify({}),
        now,
      ),
  );
  const res = await db.batch(stmts);
  return res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}
