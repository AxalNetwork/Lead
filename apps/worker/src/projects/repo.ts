// Task #47: project data-access layer.

import type { Env } from "../types";
import type { Audience, ProjectSpec } from "./score";

export interface ProjectRow {
  id: string;
  name: string;
  status: "active" | "archived";
  kind: string | null;
  one_liner: string | null;
  description: string | null;
  problems_solved: string | null;
  unique_value: string | null;
  stage: string | null;
  funding_status: string | null;
  funding_target: number | null;
  target_industries_json: string | null;
  target_geos_json: string | null;
  target_customer_size_bands_json: string | null;
  audiences_json: string | null;
  customer_persona_ids_json: string | null;
  investor_persona_ids_json: string | null;
  partner_persona_ids_json: string | null;
  hire_persona_ids_json: string | null;
  design_partner_persona_ids_json: string | null;
  embedding_dim: number | null;
  embedded_at: string | null;
  embedding_text: string | null;
  match_count_customer: number;
  match_count_investor: number;
  match_count_partner: number;
  match_count_hire: number;
  match_count_design_partner: number;
  matched_at: string | null;
  materials_json: string | null;
  ai_suggestions_json: string | null;
  last_modified: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const PROJECT_FIELDS = [
  "name","status","kind","one_liner","description","problems_solved","unique_value",
  "stage","funding_status","funding_target",
  "target_industries_json","target_geos_json","target_customer_size_bands_json",
  "audiences_json",
  "customer_persona_ids_json","investor_persona_ids_json","partner_persona_ids_json",
  "hire_persona_ids_json","design_partner_persona_ids_json",
] as const;

function arr(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function obj(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

export function rowToSpec(row: ProjectRow): ProjectSpec {
  const aud = obj(row.audiences_json) as Partial<Record<Audience, boolean>>;
  return {
    id: row.id,
    name: row.name,
    one_liner: row.one_liner,
    description: row.description,
    problems_solved: row.problems_solved,
    unique_value: row.unique_value,
    stage: row.stage,
    funding_status: row.funding_status,
    funding_target: row.funding_target,
    target_industries: arr(row.target_industries_json),
    target_geos: arr(row.target_geos_json),
    target_customer_size_bands: arr(row.target_customer_size_bands_json),
    audiences: aud,
    persona_ids: {
      customer:        arr(row.customer_persona_ids_json),
      investor:        arr(row.investor_persona_ids_json),
      partner:         arr(row.partner_persona_ids_json),
      hire:            arr(row.hire_persona_ids_json),
      design_partner:  arr(row.design_partner_persona_ids_json),
    },
  };
}

export async function listProjects(env: Env, opts?: { status?: string; limit?: number }): Promise<ProjectRow[]> {
  const status = opts?.status ?? "active";
  const limit = Math.min(Math.max(1, opts?.limit ?? 200), 500);
  const r = await env.DB.prepare(
    `SELECT * FROM projects WHERE deleted_at IS NULL AND status = ? ORDER BY last_modified DESC LIMIT ?`,
  ).bind(status, limit).all<ProjectRow>();
  return r.results ?? [];
}

export async function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`).bind(id).first<ProjectRow>();
  return r ?? null;
}

export async function insertProject(env: Env, body: Partial<ProjectRow> & { name: string }, by?: string, idOverride?: string): Promise<ProjectRow> {
  const id = idOverride ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const cols = ["id","created_by","created_at","updated_at","last_modified", ...PROJECT_FIELDS];
  const binds: unknown[] = [id, by ?? null, now, now, now];
  // Per migration 180: status NOT NULL DEFAULT 'active', kind NOT NULL DEFAULT 'product'.
  // Provide explicit defaults so unset payloads do not violate NOT NULL.
  const COL_DEFAULTS: Record<string, unknown> = { status: "active", kind: "product" };
  for (const f of PROJECT_FIELDS) {
    const v = (body as Record<string, unknown>)[f];
    binds.push(v != null ? v : (COL_DEFAULTS[f] ?? null));
  }
  await env.DB.prepare(`INSERT INTO projects (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...binds).run();
  await env.DB.prepare(`INSERT INTO project_history (id, project_id, field, new_value, changed_by) VALUES (?, ?, 'created', ?, ?)`)
    .bind(crypto.randomUUID(), id, body.name, by ?? null).run();
  const row = await getProject(env, id);
  return row!;
}

export async function updateProject(env: Env, id: string, patch: Partial<ProjectRow>, by?: string): Promise<ProjectRow | null> {
  const cur = await getProject(env, id);
  if (!cur) return null;
  const allowed = new Set<string>(PROJECT_FIELDS as readonly string[]);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const hist: Array<{ field: string; old: unknown; nw: unknown }> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
    const before = (cur as unknown as Record<string, unknown>)[k];
    if (before !== v) hist.push({ field: k, old: before, nw: v });
  }
  if (!sets.length) return cur;
  const now = new Date().toISOString();
  binds.push(now, now, id);
  await env.DB.prepare(`UPDATE projects SET ${sets.join(", ")}, updated_at = ?, last_modified = ? WHERE id = ?`).bind(...binds).run();
  for (const h of hist) {
    await env.DB.prepare(`INSERT INTO project_history (id, project_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, h.field, h.old != null ? String(h.old) : null, h.nw != null ? String(h.nw) : null, by ?? null).run();
  }
  return await getProject(env, id);
}

export async function softDeleteProject(env: Env, id: string, by?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(`UPDATE projects SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(now, now, id).run();
  const changed = ((r.meta?.changes ?? 0) as number) > 0;
  // Only audit a real archive — avoid ghost rows for not_found / already_archived.
  if (changed) {
    await env.DB.prepare(`INSERT INTO project_history (id, project_id, field, new_value, changed_by) VALUES (?, ?, 'archived', 'archived', ?)`)
      .bind(crypto.randomUUID(), id, by ?? null).run();
  }
  return changed;
}

export async function setProjectEmbeddingMeta(env: Env, id: string, dim: number, text: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE projects SET embedding_dim = ?, embedded_at = ?, embedding_text = ?, updated_at = ?, last_modified = ? WHERE id = ?`)
    .bind(dim, now, text, now, now, id).run();
}

export async function setMatchCounts(env: Env, id: string, counts: Record<string, number>): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE projects SET match_count_customer = ?, match_count_investor = ?, match_count_partner = ?, match_count_hire = ?, match_count_design_partner = ?, matched_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    counts.customer ?? 0, counts.investor ?? 0, counts.partner ?? 0, counts.hire ?? 0, counts.design_partner ?? 0,
    now, now, id,
  ).run();
}

export async function deleteMatchesForProjectAudience(env: Env, id: string, audience: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM project_matches WHERE project_id = ? AND audience = ?`).bind(id, audience).run();
}

// Recompute helper: after a fresh upsert we want stale "new"-status rows
// (i.e., the user never touched them) that did NOT make the new top-N
// to fall out of the workspace view. We do that by setting their rank
// to 0 and dropping their fit_score; rows the user moved to
// shortlisted/contacted/etc. are preserved untouched so their history
// and notes survive recomputes.
export async function demoteStaleNewMatches(
  env: Env, projectId: string, audience: string,
  keep: Array<{ entity_kind: string; entity_id: string }>,
): Promise<void> {
  if (!keep.length) {
    // Recompute yielded zero ranked candidates — demote every untouched
    // 'new' row so the workspace doesn't show stale results.
    await env.DB.prepare(
      `UPDATE project_matches SET rank = 0, fit_score = 0
         WHERE project_id = ? AND audience = ? AND status = 'new'`,
    ).bind(projectId, audience).run();
    return;
  }
  // SQLite has a 999-bind limit; chunk if we ever exceed it. 200*2 = 400, safe.
  const placeholders = keep.map(() => "(?,?)").join(",");
  const binds: unknown[] = [];
  for (const k of keep) binds.push(k.entity_kind, k.entity_id);
  await env.DB.prepare(
    `UPDATE project_matches SET rank = 0, fit_score = 0
       WHERE project_id = ? AND audience = ? AND status = 'new'
         AND (entity_kind, entity_id) NOT IN (VALUES ${placeholders})`,
  ).bind(projectId, audience, ...binds).run();
}

export interface ProjectMatchRow {
  project_id: string;
  audience: string;
  entity_kind: string;
  entity_id: string;
  rank: number;
  fit_score: number;
  persona_score: number;
  semantic_score: number;
  overlay_score: number;
  components_json: string | null;
  pitch_angle: string | null;
  pitch_angle_at: string | null;
  intro_path_json: string | null;
  status: string;
  notes: string | null;
  computed_at: string;
}

export async function listProjectMatches(env: Env, projectId: string, audience: string, opts: { limit?: number; offset?: number; status?: string; fit_min?: number; country?: string; include_demoted?: boolean } = {}): Promise<{ rows: ProjectMatchRow[]; total: number }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
  const offset = Math.max(0, opts.offset ?? 0);
  const where: string[] = ["project_id = ?", "audience = ?"];
  const binds: unknown[] = [projectId, audience];
  if (opts.status) { where.push("status = ?"); binds.push(opts.status); }
  if (typeof opts.fit_min === "number") { where.push("fit_score >= ?"); binds.push(opts.fit_min); }
  if (opts.country) {
    // Country was forwarded into components_json by the fact loaders.
    // Compare case-insensitively against the entity's iso2 code.
    where.push("lower(json_extract(components_json, '$.country')) = ?");
    binds.push(String(opts.country).toLowerCase());
  }
  // Demoted rows (rank=0, status='new') fall out of the workspace by
  // default; pass include_demoted=true to surface them (e.g., for an
  // archive view).
  if (!opts.include_demoted) where.push("(rank > 0 OR status != 'new')");
  const w = where.join(" AND ");
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM project_matches WHERE ${w}`).bind(...binds).first<{ n: number }>();
  const r = await env.DB.prepare(
    `SELECT * FROM project_matches WHERE ${w}
       ORDER BY (CASE WHEN rank = 0 THEN 999999 ELSE rank END) ASC, fit_score DESC
       LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<ProjectMatchRow>();
  return { rows: r.results ?? [], total: totalRow?.n ?? 0 };
}

export async function updateMatchStatus(env: Env, projectId: string, audience: string, entityKind: string, entityId: string, status: string, by?: string): Promise<boolean> {
  const cur = await env.DB.prepare(`SELECT status FROM project_matches WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`)
    .bind(projectId, audience, entityKind, entityId).first<{ status: string }>();
  if (!cur) return false;
  await env.DB.prepare(`UPDATE project_matches SET status = ? WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`)
    .bind(status, projectId, audience, entityKind, entityId).run();
  await env.DB.prepare(
    `INSERT INTO project_history (id, project_id, audience, entity_kind, entity_id, field, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(crypto.randomUUID(), projectId, audience, entityKind, entityId, "status", cur.status, status, by ?? null).run();
  return true;
}

export async function updateMatchNotes(env: Env, projectId: string, audience: string, entityKind: string, entityId: string, notes: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE project_matches SET notes = ? WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`,
  ).bind(notes, projectId, audience, entityKind, entityId).run();
  return ((r.meta?.changes ?? 0) as number) > 0;
}

export async function listProjectHistory(env: Env, projectId: string, limit = 200): Promise<unknown[]> {
  const r = await env.DB.prepare(
    `SELECT * FROM project_history WHERE project_id = ? ORDER BY changed_at DESC LIMIT ?`,
  ).bind(projectId, Math.min(Math.max(1, limit), 500)).all();
  return r.results ?? [];
}

// Bulk-load max persona_matches.fit_score across an attached set of
// personas, keyed by entity. Used by the matching engine to fold
// persona-side fit into a single per-entity score.
export async function loadPersonaFitMap(
  env: Env,
  personaIds: string[],
  entityKind: "account" | "buyer" | "lead" | "firm" | "company",
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!personaIds.length) return map;
  const placeholders = personaIds.map(() => "?").join(",");
  try {
    const r = await env.DB.prepare(
      `SELECT entity_id, MAX(fit_score) AS s FROM persona_matches
        WHERE persona_id IN (${placeholders}) AND entity_kind = ? AND fit_score >= 50
        GROUP BY entity_id`,
    ).bind(...personaIds, entityKind).all<{ entity_id: string; s: number }>();
    for (const row of r.results ?? []) map.set(row.entity_id, row.s);
  } catch (e) {
    console.warn("loadPersonaFitMap failed", (e as Error).message);
  }
  return map;
}

// Minimal entity fact loaders. Keep payloads small — overlays use a
// fixed set of attributes. Anything missing falls back to neutral
// defaults in the scorer.
export async function loadAccountFactsBulk(env: Env, ids: string[], _spec?: unknown): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, domain, country_iso2, intent_score, last_modified FROM accounts WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string; name: string; domain: string | null; country_iso2: string | null; intent_score: number | null; last_modified: string | null }>();
    for (const row of r.results ?? []) {
      // intent_score (0..100) doubles as our early_adopter signal — accounts
      // that have shown intent are by definition more likely to try new
      // tools as design partners.
      const intent = Number(row.intent_score ?? 0);
      map.set(row.id, {
        name: row.name, domain: row.domain, country: row.country_iso2,
        intent_score: intent, last_modified: row.last_modified,
        recent_signal_count: 0, early_adopter_score: intent,
      });
    }
    // Recent-signal counts (30d).
    const sig = await env.DB.prepare(
      `SELECT account_id, COUNT(*) AS n FROM signals
        WHERE account_id IN (${placeholders}) AND datetime(observed_at) > datetime('now','-30 days')
        GROUP BY account_id`,
    ).bind(...ids).all<{ account_id: string; n: number }>();
    for (const row of sig.results ?? []) {
      const cur = map.get(row.account_id);
      if (cur) cur.recent_signal_count = row.n;
    }
  } catch (e) {
    console.warn("loadAccountFactsBulk failed", (e as Error).message);
  }
  return map;
}

export async function loadFirmFactsBulk(env: Env, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, hq_country, stages_json, sectors_json, check_min_usd, check_max_usd, last_modified FROM firms WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string; name: string; hq_country: string | null; stages_json: string | null; sectors_json: string | null; check_min_usd: number | null; check_max_usd: number | null; last_modified: string | null }>();
    for (const row of r.results ?? []) {
      map.set(String(row.id), {
        name: row.name, country: row.hq_country,
        stages: arr(row.stages_json), sectors: arr(row.sectors_json),
        check_min: row.check_min_usd ?? 0, check_max: row.check_max_usd ?? 0,
        last_modified: row.last_modified,
      });
    }
  } catch (e) {
    console.warn("loadFirmFactsBulk failed", (e as Error).message);
  }
  return map;
}

export async function loadCompanyFactsBulk(env: Env, ids: string[], spec?: { target_industries?: string[] }): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const wantedInds = new Set((spec?.target_industries ?? []).map((s) => s.toLowerCase()));
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, domain, country_iso2, industry, industries_json, last_modified FROM companies WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string; name: string; domain: string | null; country_iso2: string | null; industry: string | null; industries_json: string | null; last_modified: string | null }>();
    for (const row of r.results ?? []) {
      const industries: string[] = (() => {
        try { const a = JSON.parse(row.industries_json ?? "[]"); return Array.isArray(a) ? a : []; }
        catch { return []; }
      })();
      const flat = new Set<string>(industries.map((s) => String(s).toLowerCase()));
      if (row.industry) flat.add(String(row.industry).toLowerCase());
      let shared = 0;
      for (const w of wantedInds) if (flat.has(w)) shared += 1;
      map.set(String(row.id), {
        name: row.name, domain: row.domain, country: row.country_iso2, industry: row.industry,
        industries: [...flat], last_modified: row.last_modified,
        is_competitor: false, shared_icp_count: shared, shared_industries: shared,
      });
    }
  } catch (e) {
    console.warn("loadCompanyFactsBulk failed", (e as Error).message);
  }
  return map;
}

const SENIOR_TIERS = new Set(["c_suite","c_level","vp","director","founder","partner","owner"]);

export async function loadLeadFactsBulk(env: Env, ids: string[], spec?: { target_industries?: string[]; required_seniority?: string[] }): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const wantedSen = new Set((spec?.required_seniority ?? []).map((s) => s.toLowerCase()));
  const wantedInds = new Set((spec?.target_industries ?? []).map((s) => s.toLowerCase()));
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, email, org, title, country_iso2, seniority, sector_focus_json, last_modified
         FROM leads WHERE id IN (${placeholders}) AND merged_into IS NULL`,
    ).bind(...ids).all<{ id: string; name: string | null; email: string | null; org: string | null; title: string | null; country_iso2: string | null; seniority: string | null; sector_focus_json: string | null; last_modified: string | null }>();
    for (const row of r.results ?? []) {
      const sen = (row.seniority ?? "").toLowerCase();
      const seniority_match = wantedSen.size ? wantedSen.has(sen) : SENIOR_TIERS.has(sen);
      const sectors: string[] = (() => {
        try { const a = JSON.parse(row.sector_focus_json ?? "[]"); return Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []; }
        catch { return []; }
      })();
      let shared = 0;
      for (const s of sectors) if (wantedInds.has(s)) shared += 1;
      map.set(String(row.id), {
        name: row.name, email: row.email, org: row.org, title: row.title, country: row.country_iso2,
        seniority: sen, seniority_match, shared_industries: shared,
        last_modified: row.last_modified,
      });
    }
  } catch (e) {
    console.warn("loadLeadFactsBulk failed", (e as Error).message);
  }
  return map;
}

// Bulk upsert of project_matches rows. SQLite doesn't ship with a clean
// UPSERT for composite PK in one statement, so we use a per-row INSERT
// OR REPLACE. Materialized inside a single batch for atomicity.
export async function bulkUpsertMatches(env: Env, projectId: string, audience: string, projectModifiedAt: string, rows: Array<{
  entity_kind: string; entity_id: string; rank: number; fit_score: number;
  persona_score: number; semantic_score: number; overlay_score: number;
  components: Record<string, unknown>; pitch_angle?: string | null; intro_path?: unknown[] | null;
  entity_modified_at?: string | null;
}>): Promise<number> {
  if (!rows.length) return 0;
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO project_matches (project_id, audience, entity_kind, entity_id, rank, fit_score, persona_score, semantic_score, overlay_score, components_json, pitch_angle, pitch_angle_at, intro_path_json, project_modified_at, entity_modified_at, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(project_id, audience, entity_kind, entity_id) DO UPDATE SET
         rank=excluded.rank, fit_score=excluded.fit_score, persona_score=excluded.persona_score,
         semantic_score=excluded.semantic_score, overlay_score=excluded.overlay_score,
         components_json=excluded.components_json,
         pitch_angle=COALESCE(excluded.pitch_angle, project_matches.pitch_angle),
         pitch_angle_at=COALESCE(excluded.pitch_angle_at, project_matches.pitch_angle_at),
         intro_path_json=excluded.intro_path_json,
         project_modified_at=excluded.project_modified_at, entity_modified_at=excluded.entity_modified_at,
         computed_at=datetime('now')`,
    ).bind(
      projectId, audience, r.entity_kind, r.entity_id, r.rank, r.fit_score,
      r.persona_score, r.semantic_score, r.overlay_score,
      JSON.stringify(r.components),
      r.pitch_angle ?? null, r.pitch_angle ? new Date().toISOString() : null,
      r.intro_path ? JSON.stringify(r.intro_path) : null,
      projectModifiedAt, r.entity_modified_at ?? null,
    ),
  );
  await env.DB.batch(stmts);
  return rows.length;
}
