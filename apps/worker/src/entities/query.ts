// High-level read helpers. `loadEntity` returns the canonical envelope
// every consumer can rely on; `searchEntities` is a thin filter DSL that
// joins entity_summary + entity_tags for sub-50ms list responses.

import type { Env } from "../types";
import type { EntityRow } from "./model";

export interface LoadedEntity {
  id: string;
  kind: string;
  roles: Array<{ role: string; is_primary: number; confidence: number }>;
  facts: Array<{ id: string; predicate: string; value_text: string | null; value_number: number | null; value_json: unknown; value_entity_id: string | null; source: string | null; source_kind: string; confidence: number; verified_score: number | null; observed_at: string; is_current: number }>;
  channels: Array<{ kind: string; canonical: string; display: string | null; is_primary: number; is_verified: number; is_dnc: number }>;
  tags: Array<{ taxonomy: string; slug: string; weight: number }>;
  summary: Record<string, unknown> | null;
  entity: EntityRow;
}

export async function loadEntity(env: Env, id: string, opts?: { includeNonCurrent?: boolean }): Promise<LoadedEntity | null> {
  const ent = await env.DB.prepare(`SELECT * FROM u_entities WHERE id = ?`).bind(id).first<EntityRow>();
  if (!ent) return null;
  const factWhere = opts?.includeNonCurrent ? "" : " AND is_current = 1";
  const [roles, facts, channels, tags, summary] = await Promise.all([
    env.DB.prepare(`SELECT role, is_primary, confidence FROM entity_roles WHERE entity_id = ?`).bind(id).all(),
    env.DB.prepare(`SELECT id, predicate, value_text, value_number, value_json, value_entity_id, source, source_kind, confidence, verified_score, observed_at, is_current FROM facts WHERE entity_id = ?${factWhere} ORDER BY observed_at DESC LIMIT 500`).bind(id).all(),
    env.DB.prepare(`SELECT kind, canonical, display, is_primary, is_verified, is_dnc FROM channels WHERE entity_id = ?`).bind(id).all(),
    env.DB.prepare(`SELECT taxonomy, slug, weight FROM entity_tags WHERE entity_id = ?`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM entity_summary WHERE entity_id = ?`).bind(id).first(),
  ]);
  const factRows = (facts.results ?? []) as LoadedEntity["facts"];
  for (const f of factRows) {
    if (f.value_json && typeof f.value_json === "string") {
      try { f.value_json = JSON.parse(f.value_json); } catch { /* leave as string */ }
    }
  }
  return {
    id, kind: ent.kind, entity: ent,
    roles: (roles.results ?? []) as LoadedEntity["roles"],
    facts: factRows,
    channels: (channels.results ?? []) as LoadedEntity["channels"],
    tags: (tags.results ?? []) as LoadedEntity["tags"],
    summary: (summary as Record<string, unknown> | null) ?? null,
  };
}

export interface SearchFilter {
  kind?: "person" | "org";
  role?: string;
  country_iso2?: string;
  sector?: string;
  stage?: string;
  geo?: string;
  check_min_usd?: number;
  check_max_usd?: number;
  has_role?: string;
  has_unicorn?: boolean;
  min_fit?: number;
  min_intent?: number;
  q?: string;
  sort?: "fit" | "intent" | "quality" | "updated";
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  items: Array<Record<string, unknown>>;
  next_offset: number | null;
}

export async function searchEntities(env: Env, f: SearchFilter): Promise<SearchResult> {
  // IMPORTANT: bind order must match SQL placeholder order. Since the
  // tag JOINs appear *before* the WHERE clause in the final SQL, their
  // binds must be pushed first. We build two separate bind arrays and
  // concatenate them in SQL order at the end.
  const joinBinds: unknown[] = [];
  const whereBinds: unknown[] = [];
  const where: string[] = ["s.status = 'active'"];
  if (f.kind) { where.push("s.kind = ?"); whereBinds.push(f.kind); }
  if (f.role) { where.push("s.primary_role = ?"); whereBinds.push(f.role); }
  if (f.country_iso2) { where.push("s.country_iso2 = ?"); whereBinds.push(f.country_iso2.toUpperCase()); }
  if (typeof f.check_min_usd === "number") { where.push("s.check_size_max_usd >= ?"); whereBinds.push(f.check_min_usd); }
  if (typeof f.check_max_usd === "number") { where.push("s.check_size_min_usd <= ?"); whereBinds.push(f.check_max_usd); }
  if (f.has_unicorn) { where.push("s.unicorn_count > 0"); }
  if (typeof f.min_fit === "number") { where.push("s.fit_max_score >= ?"); whereBinds.push(f.min_fit); }
  if (typeof f.min_intent === "number") { where.push("s.intent_score >= ?"); whereBinds.push(f.min_intent); }
  if (f.q) {
    where.push("(lower(s.display_name) LIKE ? OR lower(s.primary_domain) LIKE ? OR lower(s.primary_email) LIKE ?)");
    const q = `%${f.q.toLowerCase()}%`;
    whereBinds.push(q, q, q);
  }
  // Tag filters require a JOIN per taxonomy so we can intersect.
  // NOTE: `has_role` is *not* a tag — roles live in entity_roles
  // (addRole writes there, not entity_tags). The previous JOIN on
  // entity_tags taxonomy='role' returned empty results for every
  // wrapper helper (listFirms, listInvestors, listCompanies,
  // listAccounts, listBuyers, listFounders). We now JOIN entity_roles
  // directly for role membership.
  const joins: string[] = [];
  let tagJoinIdx = 0;
  for (const [tax, slug] of [["sector", f.sector], ["stage", f.stage], ["geo", f.geo]] as const) {
    if (!slug) continue;
    const alias = `t${++tagJoinIdx}`;
    joins.push(`JOIN entity_tags ${alias} ON ${alias}.entity_id = s.entity_id AND ${alias}.taxonomy = ? AND ${alias}.slug = ?`);
    joinBinds.push(tax, slug);
  }
  if (f.has_role) {
    joins.push(`JOIN entity_roles er ON er.entity_id = s.entity_id AND er.role = ?`);
    joinBinds.push(f.has_role);
  }
  const sortCol = (() => {
    switch (f.sort) {
      case "intent": return "s.intent_score DESC";
      case "quality": return "s.quality_score DESC";
      case "updated": return "s.rebuilt_at DESC";
      default: return "s.fit_max_score DESC";
    }
  })();
  const limit = Math.min(Math.max(1, f.limit ?? 50), 200);
  const offset = Math.max(0, f.offset ?? 0);
  const sql = `SELECT s.* FROM entity_summary s ${joins.join(" ")}
               WHERE ${where.join(" AND ")}
               ORDER BY ${sortCol}, s.entity_id ASC
               LIMIT ? OFFSET ?`;
  const r = await env.DB.prepare(sql).bind(...joinBinds, ...whereBinds, limit + 1, offset).all();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  return {
    items: (hasMore ? rows.slice(0, limit) : rows) as Array<Record<string, unknown>>,
    next_offset: hasMore ? offset + limit : null,
  };
}

export const listFirms = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "org", has_role: f.has_role ?? "firm" });
export const listInvestors = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "person", has_role: "investor" });
export const listCompanies = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "org", has_role: f.has_role ?? "company" });
export const listAccounts = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "org", has_role: "account" });
export const listBuyers = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "person", has_role: "buyer" });
export const listFounders = (env: Env, f: SearchFilter = {}) => searchEntities(env, { ...f, kind: "person", has_role: "founder" });
