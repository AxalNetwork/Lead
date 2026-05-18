// Task #4: ProjectAudienceMatcher — audience-typed projection of the
// existing project_matches pipeline.
//
// The hard work (Vectorize candidate funnel + persona-fit + audience
// overlay scoring + bulk upsert) lives in `projects/match.ts`. This
// service mirrors the top-50 per audience into `project_audience_matches`
// with a 7-day TTL, applies persistent negative-feedback as a score
// penalty, and refreshes `projects.match_count_*` so the dashboard
// chips render non-zero counts.
//
// Plural audience names exposed by the API (customers / investors /
// partners / hires / design) are mapped to the internal singulars
// (customer / investor / partner / hire / design_partner) used by the
// legacy `project_matches` table.

import type { Env } from "../../types";
import { matchProject } from "../../projects/match";
import { getProject, setMatchCounts } from "../../projects/repo";
import { AUDIENCES } from "../../projects/score";

export const AUDIENCE_API_TO_INTERNAL: Record<string, typeof AUDIENCES[number]> = {
  customers: "customer",
  investors: "investor",
  partners: "partner",
  hires: "hire",
  design: "design_partner",
};
export const AUDIENCE_INTERNAL_TO_API: Record<typeof AUDIENCES[number], string> = {
  customer: "customers",
  investor: "investors",
  partner: "partners",
  hire: "hires",
  design_partner: "design",
};
export const API_AUDIENCES = ["customers", "investors", "partners", "hires", "design"] as const;
export type ApiAudience = typeof API_AUDIENCES[number];

const TTL_DAYS = 7;
const TOP_K = 50;

interface FeedbackRow {
  entity_kind: string;
  entity_id: string;
  weight: number;
}

async function loadFeedback(
  env: Env,
  projectId: string,
  audience: ApiAudience,
): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    const r = await env.DB.prepare(
      `SELECT entity_kind, entity_id, SUM(weight) AS w
         FROM project_audience_feedback
        WHERE project_id = ? AND audience = ?
        GROUP BY entity_kind, entity_id`,
    ).bind(projectId, audience).all<FeedbackRow & { w: number }>();
    for (const row of r.results ?? []) m.set(`${row.entity_kind}:${row.entity_id}`, Number(row.w ?? 0));
  } catch (e) {
    console.warn("loadFeedback failed", (e as Error).message);
  }
  return m;
}

function clamp01(n: number): number { return n < 0 ? 0 : n > 1 ? 1 : n; }

function buildReason(row: { fit_score: number; persona_score: number; semantic_score: number; overlay_score: number; components_json: string | null }, audience: ApiAudience): string {
  let explanation: string | null = null;
  try {
    const c = JSON.parse(row.components_json ?? "{}");
    if (typeof c?.explanation === "string" && c.explanation.trim()) explanation = c.explanation.trim();
  } catch {}
  if (explanation) return explanation;
  const parts: string[] = [];
  if (row.semantic_score > 0.4) parts.push("strong semantic fit");
  else if (row.semantic_score > 0.2) parts.push("partial semantic fit");
  if (row.persona_score > 50) parts.push("matches attached persona");
  if (row.overlay_score > 0.3) parts.push(`${audience} criteria overlap`);
  return parts.length ? parts.join(" · ") : `top-ranked ${audience} candidate`;
}

async function ensureTablesOnce(env: Env): Promise<void> {
  // Migrations 338 may not be applied in dev/test environments; create
  // the tables on first use so the matcher never silently no-ops. Cheap
  // (idempotent IF NOT EXISTS) and gated behind a soft-error catch.
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_audience_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        match_score REAL NOT NULL DEFAULT 0,
        embedding_similarity REAL NOT NULL DEFAULT 0,
        criteria_overlap REAL NOT NULL DEFAULT 0,
        recency_bonus REAL NOT NULL DEFAULT 0,
        feedback_penalty REAL NOT NULL DEFAULT 0,
        score_breakdown_json TEXT,
        reason TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        UNIQUE (project_id, audience, entity_kind, entity_id)
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pam_project_audience_score
        ON project_audience_matches(project_id, audience, match_score DESC)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pam_expires
        ON project_audience_matches(expires_at)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_audience_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        signal TEXT NOT NULL DEFAULT 'not_relevant',
        weight REAL NOT NULL DEFAULT 0.5,
        created_by_email TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, audience, entity_kind, entity_id, signal)
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_paf_project_audience
        ON project_audience_feedback(project_id, audience)`),
    ]);
  } catch (e) {
    console.warn("ensureTablesOnce failed", (e as Error).message);
  }
}

export interface ProjectMatchSummary {
  ok: true;
  project_id: string;
  audiences: Array<{ audience: ApiAudience; count: number }>;
}

// Main entrypoint. Runs the full match pipeline then mirrors the top-50
// per audience into project_audience_matches with feedback applied.
export async function runAudienceMatching(env: Env, projectId: string): Promise<ProjectMatchSummary> {
  await ensureTablesOnce(env);
  const project = await getProject(env, projectId);
  if (!project) throw new Error(`project_not_found:${projectId}`);

  // Phase 1 — run the underlying ranker (writes project_matches + counters).
  await matchProject(env, projectId);

  const now = new Date();
  const computedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TTL_DAYS * 86400_000).toISOString();
  const summary: ProjectMatchSummary = { ok: true, project_id: projectId, audiences: [] };
  const newCounts: Record<string, number> = {};

  for (const internal of AUDIENCES) {
    const apiAud = AUDIENCE_INTERNAL_TO_API[internal] as ApiAudience;
    const feedback = await loadFeedback(env, projectId, apiAud);

    // Pull top candidates from project_matches (already filtered to
    // allowed kinds per audience by the underlying scorer).
    const r = await env.DB.prepare(
      `SELECT entity_kind, entity_id, rank, fit_score, persona_score, semantic_score,
              overlay_score, components_json
         FROM project_matches
        WHERE project_id = ? AND audience = ? AND rank > 0
        ORDER BY rank ASC LIMIT ?`,
    ).bind(projectId, internal, TOP_K * 2).all<{
      entity_kind: string; entity_id: string; rank: number; fit_score: number;
      persona_score: number; semantic_score: number; overlay_score: number;
      components_json: string | null;
    }>();

    // Score, apply feedback penalty, sort, keep top-K.
    const scored: Array<{
      entity_kind: string; entity_id: string; match_score: number;
      embedding_similarity: number; criteria_overlap: number; recency_bonus: number;
      feedback_penalty: number; breakdown: Record<string, unknown>; reason: string;
    }> = [];
    for (const m of r.results ?? []) {
      // fit_score is 0..100 in project_matches; semantic is cosine 0..1;
      // overlay 0..1; persona 0..100. Normalize to 0..1 for match_score.
      const baseScore = clamp01((m.fit_score ?? 0) / 100);
      const penalty = feedback.get(`${m.entity_kind}:${m.entity_id}`) ?? 0;
      const finalScore = clamp01(baseScore - penalty);
      if (finalScore <= 0) continue;
      let recency = 0;
      let breakdown: Record<string, unknown> = {};
      try {
        breakdown = JSON.parse(m.components_json ?? "{}");
        const lm = String(breakdown.last_modified ?? "");
        if (lm) {
          const ageDays = (now.getTime() - new Date(lm).getTime()) / 86400_000;
          if (ageDays < 7) recency = 0.15;
          else if (ageDays < 30) recency = 0.08;
          else if (ageDays < 90) recency = 0.03;
        }
      } catch {}
      scored.push({
        entity_kind: m.entity_kind,
        entity_id: m.entity_id,
        match_score: finalScore,
        embedding_similarity: clamp01(m.semantic_score ?? 0),
        criteria_overlap: clamp01(m.overlay_score ?? 0),
        recency_bonus: recency,
        feedback_penalty: penalty,
        breakdown,
        reason: buildReason(m, apiAud),
      });
    }
    scored.sort((a, b) => b.match_score - a.match_score);
    const top = scored.slice(0, TOP_K);
    newCounts[internal] = top.length;
    summary.audiences.push({ audience: apiAud, count: top.length });

    // Drop existing rows for this (project, audience) so deletions
    // propagate (e.g., a previously-matched entity that now fails
    // criteria). Then upsert the fresh top-K with 7d TTL.
    await env.DB.prepare(
      `DELETE FROM project_audience_matches WHERE project_id = ? AND audience = ?`,
    ).bind(projectId, apiAud).run();

    if (top.length) {
      const stmts = top.map((s) =>
        env.DB.prepare(
          `INSERT INTO project_audience_matches
             (project_id, audience, entity_kind, entity_id, match_score,
              embedding_similarity, criteria_overlap, recency_bonus, feedback_penalty,
              score_breakdown_json, reason, computed_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          projectId, apiAud, s.entity_kind, s.entity_id, s.match_score,
          s.embedding_similarity, s.criteria_overlap, s.recency_bonus, s.feedback_penalty,
          JSON.stringify(s.breakdown), s.reason, computedAt, expiresAt,
        ),
      );
      try { await env.DB.batch(stmts); }
      catch (e) { console.warn("project_audience_matches upsert failed", apiAud, (e as Error).message); }
    }
  }

  // Reflect counts on the project row (overrides whatever matchProject
  // wrote so the dashboard chip uses the feedback-adjusted top-K count).
  await setMatchCounts(env, projectId, newCounts);

  return summary;
}

export interface AudienceMatchListItem {
  entity_kind: string;
  entity_id: string;
  entity_name: string | null;
  entity_subtitle: string | null;
  match_score: number;
  embedding_similarity: number;
  criteria_overlap: number;
  recency_bonus: number;
  feedback_penalty: number;
  reason: string;
  computed_at: string;
}

interface NameLookup { name: string | null; subtitle: string | null }

async function hydrateNames(env: Env, rows: Array<{ entity_kind: string; entity_id: string }>): Promise<Map<string, NameLookup>> {
  const map = new Map<string, NameLookup>();
  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byKind.get(r.entity_kind) ?? [];
    arr.push(r.entity_id);
    byKind.set(r.entity_kind, arr);
  }
  for (const [kind, ids] of byKind) {
    if (!ids.length) continue;
    const ph = ids.map(() => "?").join(",");
    let q = "";
    if (kind === "lead") q = `SELECT id, name, org AS subtitle FROM leads WHERE id IN (${ph})`;
    else if (kind === "account") q = `SELECT id, name, domain AS subtitle FROM accounts WHERE id IN (${ph})`;
    else if (kind === "firm") q = `SELECT id, name, hq_country AS subtitle FROM firms WHERE id IN (${ph})`;
    else if (kind === "company") q = `SELECT id, name, domain AS subtitle FROM companies WHERE id IN (${ph})`;
    else continue;
    try {
      const r = await env.DB.prepare(q).bind(...ids).all<{ id: string | number; name: string | null; subtitle: string | null }>();
      for (const row of r.results ?? []) {
        map.set(`${kind}:${row.id}`, { name: row.name ?? null, subtitle: row.subtitle ?? null });
      }
    } catch (e) { console.warn("hydrateNames failed", kind, (e as Error).message); }
  }
  return map;
}

export async function listAudienceTop(
  env: Env,
  projectId: string,
  audience: ApiAudience,
  limit = 25,
): Promise<AudienceMatchListItem[]> {
  await ensureTablesOnce(env);
  const r = await env.DB.prepare(
    `SELECT entity_kind, entity_id, match_score, embedding_similarity, criteria_overlap,
            recency_bonus, feedback_penalty, reason, computed_at
       FROM project_audience_matches
      WHERE project_id = ? AND audience = ? AND expires_at > datetime('now')
      ORDER BY match_score DESC
      LIMIT ?`,
  ).bind(projectId, audience, Math.min(Math.max(1, limit), 200)).all<{
    entity_kind: string; entity_id: string; match_score: number;
    embedding_similarity: number; criteria_overlap: number; recency_bonus: number;
    feedback_penalty: number; reason: string | null; computed_at: string;
  }>();
  const rows = r.results ?? [];
  const names = await hydrateNames(env, rows);
  return rows.map((row) => {
    const nm = names.get(`${row.entity_kind}:${row.entity_id}`) ?? { name: null, subtitle: null };
    return {
      entity_kind: row.entity_kind,
      entity_id: row.entity_id,
      entity_name: nm.name,
      entity_subtitle: nm.subtitle,
      match_score: row.match_score,
      embedding_similarity: row.embedding_similarity,
      criteria_overlap: row.criteria_overlap,
      recency_bonus: row.recency_bonus,
      feedback_penalty: row.feedback_penalty,
      reason: row.reason ?? "",
      computed_at: row.computed_at,
    };
  });
}

export async function getAudienceCounts(env: Env, projectId: string): Promise<Record<ApiAudience, number>> {
  await ensureTablesOnce(env);
  const out: Record<ApiAudience, number> = { customers: 0, investors: 0, partners: 0, hires: 0, design: 0 };
  try {
    const r = await env.DB.prepare(
      `SELECT audience, COUNT(*) AS n FROM project_audience_matches
        WHERE project_id = ? AND expires_at > datetime('now')
        GROUP BY audience`,
    ).bind(projectId).all<{ audience: string; n: number }>();
    for (const row of r.results ?? []) {
      if ((API_AUDIENCES as readonly string[]).includes(row.audience)) {
        out[row.audience as ApiAudience] = Number(row.n ?? 0);
      }
    }
  } catch (e) { console.warn("getAudienceCounts failed", (e as Error).message); }
  return out;
}

export async function recordFeedback(
  env: Env,
  projectId: string,
  audience: ApiAudience,
  entityKind: string,
  entityId: string,
  signal: string,
  byEmail: string | null,
): Promise<{ ok: true; penalty_applied: number }> {
  await ensureTablesOnce(env);
  const weight = signal === "not_relevant" ? 0.5 : 0.25;
  await env.DB.prepare(
    `INSERT INTO project_audience_feedback
       (project_id, audience, entity_kind, entity_id, signal, weight, created_by_email)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(project_id, audience, entity_kind, entity_id, signal) DO UPDATE SET
       weight = excluded.weight,
       created_by_email = excluded.created_by_email,
       created_at = datetime('now')`,
  ).bind(projectId, audience, entityKind, entityId, signal, weight, byEmail ?? null).run();

  // Apply penalty immediately to the live row so the drawer reflects
  // the change without waiting for a recompute.
  try {
    await env.DB.prepare(
      `UPDATE project_audience_matches
          SET feedback_penalty = ?, match_score = MAX(0, match_score - ?)
        WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`,
    ).bind(weight, weight, projectId, audience, entityKind, entityId).run();
  } catch (e) { console.warn("apply feedback penalty failed", (e as Error).message); }

  return { ok: true, penalty_applied: weight };
}
