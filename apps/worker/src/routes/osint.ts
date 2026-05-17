// Task #3 OSINT routes.
//
//   GET    /api/osint/entity/:id            → known handles + coverage + run state
//   POST   /api/osint/entity/:id/resolve    → dispatch a fresh resolve (workflow if bound)
//   GET    /api/osint/entity/:id/coverage   → per-platform coverage matrix
//   POST   /api/osint/entity/:id/probe      → single-platform handle probe (manual)
//   GET    /api/osint/candidates            → review queue (filter by status)
//   POST   /api/osint/candidates/:id/accept → promote candidate → identity_handles
//   POST   /api/osint/candidates/:id/reject → mark rejected (no demotion)

import { Hono } from "hono";
import type { Env } from "../types";
import { PLATFORMS, getPlatform } from "../osint/platforms";
import { resolveEntity } from "../osint/resolve";
import { simpleGet, bodyLooksLikeMiss } from "../osint/pivots/_util";

export const osint = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface HandleRow {
  id: string; entity_id: string; platform: string; handle: string; url: string | null;
  link_method: string; link_confidence: number; evidence_json: string | null;
  is_active: number; last_verified_at: string; demoted_reason: string | null; updated_at: string;
}
interface CandidateRow {
  id: string; entity_id: string; platform: string; handle: string; url: string | null;
  link_method: string; link_confidence: number; evidence_json: string | null;
  status: string; reviewer_email: string | null; reviewed_at: string | null;
  reviewer_notes: string | null; created_at: string;
}

osint.get("/entity/:id", async (c) => {
  const id = c.req.param("id");
  const [hRes, sRes, cRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, entity_id, platform, handle, url, link_method, link_confidence,
              evidence_json, is_active, last_verified_at, demoted_reason, updated_at
         FROM identity_handles WHERE entity_id = ? ORDER BY is_active DESC, link_confidence DESC, platform ASC`,
    ).bind(id).all<HandleRow>(),
    c.env.DB.prepare(
      `SELECT last_osint_run_at, last_reverify_at, pivots_log_json FROM osint_entity_state WHERE entity_id = ?`,
    ).bind(id).first<{ last_osint_run_at: string | null; last_reverify_at: string | null; pivots_log_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM handle_candidates WHERE entity_id = ? AND status = 'pending'`,
    ).bind(id).first<{ n: number }>(),
  ]);

  const handles = (hRes.results ?? []).map((r) => ({
    ...r,
    evidence: r.evidence_json ? safeJson(r.evidence_json) : null,
  }));

  return c.json({
    entity_id: id,
    handles,
    pending_candidates: cRes?.n ?? 0,
    last_osint_run_at: sRes?.last_osint_run_at ?? null,
    last_reverify_at: sRes?.last_reverify_at ?? null,
    pivots_log: sRes?.pivots_log_json ? safeJson(sRes.pivots_log_json) : null,
  });
});

// Spec contract: /api/osint/coverage/:id is the canonical path.
// /entity/:id/coverage retained as a back-compat alias (same handler body).
const coverageImpl = async (c: {
  req: { param(name: string): string };
  env: Env;
  json(data: unknown): Response;
}): Promise<Response> => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare(
    `SELECT platform, MAX(is_active) AS is_active, MAX(link_confidence) AS conf
       FROM identity_handles WHERE entity_id = ? GROUP BY platform`,
  ).bind(id).all<{ platform: string; is_active: number; conf: number }>();
  const map = new Map<string, { active: boolean; conf: number }>();
  for (const row of r.results ?? []) map.set(row.platform, { active: !!row.is_active, conf: row.conf });
  const matrix = PLATFORMS.map((p) => ({
    platform: p.slug,
    label: p.label,
    category: p.category,
    active: map.get(p.slug)?.active ?? false,
    confidence: map.get(p.slug)?.conf ?? 0,
  }));
  const covered = matrix.filter((m) => m.active).length;
  const missing = matrix.filter((m) => !m.active).map((m) => m.platform);
  return c.json({ entity_id: id, total_platforms: PLATFORMS.length, covered, missing, matrix });
};
osint.get("/coverage/:id", (c) => coverageImpl(c));
osint.get("/entity/:id/coverage", (c) => coverageImpl(c));

osint.post("/entity/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { manualReviewOnly?: boolean; sync?: boolean };
  // Dispatch the workflow if available; otherwise run inline (capped).
  if (c.env.WF_OSINT_RESOLVE_ENTITY && !body.sync) {
    try {
      const w = await c.env.WF_OSINT_RESOLVE_ENTITY.create({ params: { entityId: id, manualReviewOnly: !!body.manualReviewOnly } });
      return c.json({ ok: true, workflow_id: w.id, mode: "workflow" });
    } catch (e) {
      console.warn("osint workflow dispatch failed, running inline", (e as Error).message);
    }
  }
  const summary = await resolveEntity(c.env, id, { totalBudgetMs: 45_000, manualReviewOnly: !!body.manualReviewOnly });
  return c.json({ ok: true, mode: "inline", summary });
});

osint.post("/entity/:id/probe", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { platform?: string; handle?: string } | null;
  if (!body?.platform || !body?.handle) return c.json({ error: "bad_request", message: "platform + handle required" }, 400);
  const def = getPlatform(body.platform);
  if (!def) return c.json({ error: "unknown_platform" }, 400);
  const url = def.probeUrlOf ? def.probeUrlOf(body.handle) : def.urlOf(body.handle);
  const res = await simpleGet(url, { timeoutMs: 6000, accept: def.probeUrlOf ? "application/json" : "text/html" });
  const miss = res.status === 404 || (res.ok && bodyLooksLikeMiss(res.text, def.notFoundHints));
  const exists = res.ok && !miss;
  if (exists) {
    // Surface as a candidate at confidence 0.5 (manual probe → reviewer decides).
    await c.env.DB.prepare(
      `INSERT INTO handle_candidates (id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json, status)
       VALUES (?, ?, ?, ?, ?, 'manual', 0.5, ?, 'pending')
       ON CONFLICT(platform, handle, entity_id) DO UPDATE SET
         link_confidence = max(handle_candidates.link_confidence, excluded.link_confidence),
         updated_at = datetime('now')`,
    ).bind(
      crypto.randomUUID(), id, def.slug, body.handle.toLowerCase(),
      def.urlOf(body.handle), JSON.stringify({ kind: "manual_probe", status: res.status, by: c.get("email") ?? null }),
    ).run();
  }
  return c.json({ ok: true, platform: def.slug, handle: body.handle, exists, http_status: res.status, profile_url: def.urlOf(body.handle) });
});

osint.get("/candidates", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const entityId = c.req.query("entity_id");
  const platform = c.req.query("platform");
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const where = ["status = ?"]; const binds: unknown[] = [status];
  if (entityId) { where.push("entity_id = ?"); binds.push(entityId); }
  if (platform) { where.push("platform = ?"); binds.push(platform); }
  const r = await c.env.DB.prepare(
    `SELECT id, entity_id, platform, handle, url, link_method, link_confidence,
            evidence_json, status, reviewer_email, reviewed_at, reviewer_notes, created_at
       FROM handle_candidates WHERE ${where.join(" AND ")} ORDER BY link_confidence DESC, created_at DESC LIMIT ?`,
  ).bind(...binds, limit).all<CandidateRow>();
  const items = (r.results ?? []).map((row) => ({
    ...row,
    evidence: row.evidence_json ? safeJson(row.evidence_json) : null,
  }));
  return c.json({ items });
});

osint.post("/candidates/:id/accept", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const row = await c.env.DB.prepare(
    `SELECT id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json
       FROM handle_candidates WHERE id = ? AND status = 'pending'`,
  ).bind(id).first<CandidateRow>();
  if (!row) return c.json({ error: "not_found_or_already_reviewed" }, 404);

  // Promote → identity_handles. Manual accept overrides guardrails.
  await c.env.DB.prepare(
    `INSERT INTO identity_handles (id, entity_id, platform, handle, url, link_method, link_confidence, evidence_json, is_active, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(entity_id, platform, handle) DO UPDATE SET
       url = COALESCE(excluded.url, identity_handles.url),
       link_method = excluded.link_method,
       link_confidence = max(identity_handles.link_confidence, excluded.link_confidence),
       evidence_json = excluded.evidence_json,
       is_active = 1, last_verified_at = datetime('now'), updated_at = datetime('now')`,
  ).bind(
    crypto.randomUUID(), row.entity_id, row.platform, row.handle, row.url,
    row.link_method, Math.max(0.85, row.link_confidence), row.evidence_json,
  ).run();
  await c.env.DB.prepare(
    `UPDATE handle_candidates SET status = 'accepted', reviewer_email = ?, reviewed_at = datetime('now') WHERE id = ?`,
  ).bind(email, id).run();
  return c.json({ ok: true });
});

// Quick-reject a linked handle from the Identities tab. Marks the row
// inactive (is_active=0) with a demoted_reason so the audit trail survives.
osint.post("/handles/:id/reject", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  const reason = body.reason ? `operator_rejected:${email ?? "unknown"}:${body.reason}` : `operator_rejected:${email ?? "unknown"}`;
  const r = await c.env.DB.prepare(
    `UPDATE identity_handles
        SET is_active = 0, demoted_reason = ?, updated_at = datetime('now')
        WHERE id = ?`,
  ).bind(reason, id).run();
  if (!r.meta || !r.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

osint.post("/candidates/:id/reject", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  await c.env.DB.prepare(
    `UPDATE handle_candidates
        SET status = 'rejected', reviewer_email = ?, reviewed_at = datetime('now'),
            reviewer_notes = ?
        WHERE id = ? AND status = 'pending'`,
  ).bind(email, body.reason ?? null, id).run();
  return c.json({ ok: true });
});

osint.get("/platforms", async (c) => {
  return c.json({
    count: PLATFORMS.length,
    items: PLATFORMS.map((p) => ({ slug: p.slug, label: p.label, category: p.category })),
  });
});

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
