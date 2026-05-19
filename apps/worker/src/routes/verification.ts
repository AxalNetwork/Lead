// Task #14: verification + reference-network routes.
//
//   GET  /api/persons/:id/verifications   — claim findings (current rows only)
//   GET  /api/persons/:id/references      — ranked reference candidates
//   POST /api/persons/:id/verify          — admin: re-trigger runner
//
// All routes are gated by accessGuard at the api.use("/api/*") layer.
// The POST trigger is admin-gated via the inline isAdmin check.

import { Hono } from "hono";
import type { Env } from "../types";
import { runVerifiers } from "../services/verification/runner";
import { buildReferenceCandidates } from "../services/verification/references";

export const personsVerificationRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

personsVerificationRoute.get("/:id/verifications", async (c) => {
  const id = c.req.param("id");
  try {
    // Stamp last_viewed_at so the nightly sweep prioritizes recently-viewed persons.
    await c.env.DB.prepare(
      `INSERT INTO person_verification_state (entity_id, last_viewed_at, updated_at)
       VALUES (?, datetime('now'), datetime('now'))
       ON CONFLICT(entity_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at, updated_at = excluded.last_viewed_at`,
    ).bind(id).run();
  } catch { /* state stamp is best-effort */ }

  let items: unknown[] = [];
  let state: { last_verified_at: string | null; last_viewed_at: string | null } | null = null;
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, claim_predicate, claim_summary, verifier_name, verifier_version,
              status, confidence, evidence_snippet, evidence_url, sources_json, reason, created_at
         FROM verification_findings
        WHERE person_entity_id = ? AND is_current = 1
        ORDER BY status, created_at DESC`,
    ).bind(id).all();
    items = (r.results ?? []).map((row) => {
      const r2 = row as Record<string, unknown>;
      let sources: string[] = [];
      try { sources = r2.sources_json ? JSON.parse(String(r2.sources_json)) as string[] : []; } catch { sources = []; }
      return { ...r2, sources_json: undefined, sources };
    });
  } catch { items = []; }
  try {
    state = await c.env.DB.prepare(
      `SELECT last_verified_at, last_viewed_at FROM person_verification_state WHERE entity_id = ?`,
    ).bind(id).first<{ last_verified_at: string | null; last_viewed_at: string | null }>();
  } catch { state = null; }

  return c.json({ entity_id: id, items, state });
});

personsVerificationRoute.get("/:id/references", async (c) => {
  const id = c.req.param("id");
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, ref_entity_id, ref_display_name, relationship_kind, shared_context,
              time_overlap_months, confidence, reasoning, evidence_url, refreshed_at
         FROM reference_candidates
        WHERE subject_entity_id = ?
        ORDER BY confidence DESC, time_overlap_months DESC NULLS LAST
        LIMIT 200`,
    ).bind(id).all();
    return c.json({ entity_id: id, items: r.results ?? [] });
  } catch {
    return c.json({ entity_id: id, items: [] });
  }
});

personsVerificationRoute.post("/:id/verify", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const summary = await runVerifiers(c.env, id);
  const refSummary = await buildReferenceCandidates(c.env, id);
  return c.json({ verifications: summary, references: refSummary });
});
