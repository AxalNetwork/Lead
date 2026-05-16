// Task #46: persona data-access layer.

import type { Env } from "../types";
import type { AccountFacts, BuyerFacts, PersonaSpec, ScoreComponents, WeightKey } from "./score";

export interface PersonaRow {
  id: string;
  name: string;
  kind: "account" | "buyer";
  status: "active" | "archived";
  thesis: string | null;
  hard_filters_json: string | null;
  size_min: number | null;
  size_max: number | null;
  size_bands_json: string | null;
  geos_json: string | null;
  industries_json: string | null;
  techs_required_json: string | null;
  techs_preferred_json: string | null;
  techs_excluded_json: string | null;
  signal_kinds_json: string | null;
  buyer_titles_json: string | null;
  buyer_seniority_json: string | null;
  buyer_departments_json: string | null;
  weights_json: string | null;
  semantic_fit_threshold: number | null;
  recency_boost: number | null;
  embedding_dim: number | null;
  embedded_at: string | null;
  embedding_text: string | null;
  persona_notes: string | null;
  notes_generated_at: string | null;
  last_modified: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export const PERSONA_FIELDS = [
  "name","kind","status","thesis",
  "hard_filters_json","size_min","size_max","size_bands_json",
  "geos_json","industries_json",
  "techs_required_json","techs_preferred_json","techs_excluded_json",
  "signal_kinds_json","buyer_titles_json","buyer_seniority_json","buyer_departments_json",
  "weights_json","semantic_fit_threshold","recency_boost",
] as const;

function parseJsonArr(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function parseJsonObj(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

export function rowToSpec(row: PersonaRow): PersonaSpec {
  const w = parseJsonObj(row.weights_json) as Partial<Record<WeightKey, number>>;
  return {
    id: row.id,
    kind: row.kind,
    size_min: row.size_min,
    size_max: row.size_max,
    size_bands: parseJsonArr(row.size_bands_json),
    geos: parseJsonArr(row.geos_json),
    industries: parseJsonArr(row.industries_json),
    techs_required: parseJsonArr(row.techs_required_json),
    techs_preferred: parseJsonArr(row.techs_preferred_json),
    techs_excluded: parseJsonArr(row.techs_excluded_json),
    signal_kinds: parseJsonArr(row.signal_kinds_json),
    buyer_titles: parseJsonArr(row.buyer_titles_json),
    buyer_seniority: parseJsonArr(row.buyer_seniority_json),
    buyer_departments: parseJsonArr(row.buyer_departments_json),
    hard_filters: parseJsonObj(row.hard_filters_json),
    weights: w,
    semantic_fit_threshold: row.semantic_fit_threshold ?? 0.55,
    recency_boost: row.recency_boost ?? 0,
  };
}

export async function listPersonas(env: Env, opts?: { status?: string; limit?: number }): Promise<PersonaRow[]> {
  const status = opts?.status ?? "active";
  const limit = Math.min(Math.max(1, opts?.limit ?? 200), 500);
  const r = await env.DB.prepare(
    `SELECT * FROM personas WHERE deleted_at IS NULL AND status = ? ORDER BY last_modified DESC LIMIT ?`,
  ).bind(status, limit).all<PersonaRow>();
  return r.results ?? [];
}

export async function getPersona(env: Env, id: string): Promise<PersonaRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM personas WHERE id = ? AND deleted_at IS NULL`).bind(id).first<PersonaRow>();
  return r ?? null;
}

export async function getPersonaIncludingDeleted(env: Env, id: string): Promise<PersonaRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM personas WHERE id = ?`).bind(id).first<PersonaRow>();
  return r ?? null;
}

export async function insertPersona(env: Env, body: Partial<PersonaRow> & { name: string; kind?: "account"|"buyer" }, by?: string, idOverride?: string): Promise<PersonaRow> {
  const id = idOverride ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const cols = ["id","created_by","created_at","updated_at","last_modified", ...PERSONA_FIELDS];
  const binds: unknown[] = [id, by ?? null, now, now, now];
  // Defaults for NOT NULL columns when the caller omits them (e.g. the
  // seed loader). Without this, the seed path threw
  // `NOT NULL constraint failed: personas.status` and surfaced as a
  // db_error on the Personas page.
  const defaults: Record<string, unknown> = { status: "active", kind: "account" };
  for (const f of PERSONA_FIELDS) {
    const v = (body as Record<string, unknown>)[f];
    binds.push(v ?? defaults[f] ?? null);
  }
  await env.DB.prepare(`INSERT INTO personas (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...binds).run();
  await env.DB.prepare(`INSERT INTO persona_history (id, persona_id, field, new_value, changed_by) VALUES (?, ?, 'created', ?, ?)`)
    .bind(crypto.randomUUID(), id, body.name, by ?? null).run();
  const row = await getPersona(env, id);
  return row!;
}

export async function updatePersona(env: Env, id: string, patch: Partial<PersonaRow>, by?: string): Promise<PersonaRow | null> {
  const cur = await getPersona(env, id);
  if (!cur) return null;
  const allowed = new Set<string>(PERSONA_FIELDS as readonly string[]);
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
  await env.DB.prepare(`UPDATE personas SET ${sets.join(", ")}, updated_at = ?, last_modified = ? WHERE id = ?`).bind(...binds).run();
  for (const h of hist) {
    await env.DB.prepare(`INSERT INTO persona_history (id, persona_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, h.field, h.old != null ? String(h.old) : null, h.nw != null ? String(h.nw) : null, by ?? null).run();
  }
  return await getPersona(env, id);
}

export async function setPersonaEmbeddingMeta(env: Env, id: string, dim: number, text: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE personas SET embedding_dim = ?, embedded_at = ?, embedding_text = ?, updated_at = ?, last_modified = ? WHERE id = ?`)
    .bind(dim, now, text, now, now, id).run();
}

export async function setPersonaNotes(env: Env, id: string, notes: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE personas SET persona_notes = ?, notes_generated_at = ?, updated_at = ? WHERE id = ?`)
    .bind(notes, now, now, id).run();
}

export async function softDeletePersona(env: Env, id: string, by?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(`UPDATE personas SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, now, id).run();
  if ((r.meta?.changes ?? 0) > 0) {
    await env.DB.prepare(`INSERT INTO persona_history (id, persona_id, field, new_value, changed_by) VALUES (?, ?, 'archived', ?, ?)`)
      .bind(crypto.randomUUID(), id, now, by ?? null).run();
    return true;
  }
  return false;
}

export async function upsertMatch(env: Env, args: {
  persona_id: string;
  entity_kind: "account" | "buyer";
  entity_id: string;
  fit_score: number;
  hard_filter_pass: number;
  components: ScoreComponents;
  explanation: string | null;
  persona_modified_at: string;
  entity_modified_at: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO persona_matches (persona_id, entity_kind, entity_id, fit_score, hard_filter_pass, components_json, explanation, explanation_at, persona_modified_at, entity_modified_at, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(persona_id, entity_kind, entity_id) DO UPDATE SET
       fit_score = excluded.fit_score,
       hard_filter_pass = excluded.hard_filter_pass,
       components_json = excluded.components_json,
       -- Drop the cached AI explanation when the new score falls below
       -- the explanation threshold so we don't keep stale "why this
       -- fits" rationale next to a low score. When the new score is
       -- still high but no fresh explanation was generated this pass
       -- (e.g. budget cap), keep the previous text — explanation_at
       -- preserves the original timestamp so callers can detect age.
       explanation = CASE
         WHEN excluded.fit_score < 50 THEN NULL
         WHEN excluded.explanation IS NOT NULL THEN excluded.explanation
         ELSE persona_matches.explanation
       END,
       explanation_at = CASE
         WHEN excluded.fit_score < 50 THEN NULL
         WHEN excluded.explanation IS NOT NULL THEN excluded.explanation_at
         ELSE persona_matches.explanation_at
       END,
       persona_modified_at = excluded.persona_modified_at,
       entity_modified_at = excluded.entity_modified_at,
       computed_at = excluded.computed_at`,
  ).bind(
    args.persona_id, args.entity_kind, args.entity_id, args.fit_score, args.hard_filter_pass,
    JSON.stringify(args.components), args.explanation, args.explanation ? now : null,
    args.persona_modified_at, args.entity_modified_at, now,
  ).run();
}

export async function listMatches(env: Env, personaId: string, opts: { kind?: "account"|"buyer"; minScore?: number; limit?: number; offset?: number }): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const offset = Math.max(0, opts.offset ?? 0);
  const minScore = Math.max(0, opts.minScore ?? 0);
  const kind = opts.kind ?? "account";
  if (kind === "account") {
    const r = await env.DB.prepare(
      `SELECT pm.*, a.name AS entity_name, a.domain AS entity_domain, a.industry AS entity_industry, a.employees AS entity_employees, a.account_score AS entity_account_score
       FROM persona_matches pm
       JOIN accounts a ON a.id = pm.entity_id
       WHERE pm.persona_id = ? AND pm.entity_kind = 'account' AND pm.fit_score >= ?
       ORDER BY pm.fit_score DESC LIMIT ? OFFSET ?`,
    ).bind(personaId, minScore, limit, offset).all();
    return r.results ?? [];
  }
  const r = await env.DB.prepare(
    `SELECT pm.*, b.name AS entity_name, b.title AS entity_title, b.seniority AS entity_seniority, b.account_id AS entity_account_id
     FROM persona_matches pm
     JOIN buyers b ON b.id = pm.entity_id
     WHERE pm.persona_id = ? AND pm.entity_kind = 'buyer' AND pm.fit_score >= ?
     ORDER BY pm.fit_score DESC LIMIT ? OFFSET ?`,
  ).bind(personaId, minScore, limit, offset).all();
  return r.results ?? [];
}

export async function countMatches(env: Env, personaId: string, minScore = 60): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM persona_matches WHERE persona_id = ? AND fit_score >= ?`).bind(personaId, minScore).first<{ c: number }>();
  return r?.c ?? 0;
}

export async function deleteMatchesForPersona(env: Env, personaId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM persona_matches WHERE persona_id = ?`).bind(personaId).run();
}

export async function listMatchesForEntity(env: Env, entityKind: "account"|"buyer", entityId: string): Promise<Array<{ persona_id: string; fit_score: number }>> {
  const r = await env.DB.prepare(
    `SELECT persona_id, fit_score FROM persona_matches
      WHERE entity_kind = ? AND entity_id = ?
      ORDER BY fit_score DESC`,
  ).bind(entityKind, entityId).all<{ persona_id: string; fit_score: number }>();
  return r.results ?? [];
}

// Task #58: surface persona-fit on the account/buyer detail pages.
// Joins persona_matches with personas so the dashboard can render a
// "Persona fit" panel without a second round-trip per row. Returns
// rows above `minScore` (default 50, matching the explanation cache
// floor in upsertMatch) sorted by score desc. Skips archived/deleted
// personas — matches against an archived persona are stale evidence.
export async function listMatchesForEntityWithDetails(
  env: Env,
  entityKind: "account" | "buyer",
  entityId: string,
  opts?: { minScore?: number; personaKind?: "account" | "buyer" },
): Promise<Array<{
  persona_id: string;
  persona_name: string;
  persona_kind: "account" | "buyer";
  persona_status: string;
  persona_thesis: string | null;
  fit_score: number;
  hard_filter_pass: number;
  components: unknown;
  explanation: string | null;
  explanation_at: string | null;
  computed_at: string;
}>> {
  const minScore = Math.max(0, opts?.minScore ?? 50);
  const personaKind = opts?.personaKind ?? entityKind;
  const r = await env.DB.prepare(
    `SELECT pm.persona_id, pm.fit_score, pm.hard_filter_pass, pm.components_json,
            pm.explanation, pm.explanation_at, pm.computed_at,
            p.name AS persona_name, p.kind AS persona_kind,
            p.status AS persona_status, p.thesis AS persona_thesis
       FROM persona_matches pm
       JOIN personas p ON p.id = pm.persona_id
      WHERE pm.entity_kind = ? AND pm.entity_id = ?
        AND pm.fit_score >= ?
        AND p.deleted_at IS NULL
        AND p.status = 'active'
        AND p.kind = ?
      ORDER BY pm.fit_score DESC`,
  ).bind(entityKind, entityId, minScore, personaKind).all<{
    persona_id: string; fit_score: number; hard_filter_pass: number;
    components_json: string | null; explanation: string | null;
    explanation_at: string | null; computed_at: string;
    persona_name: string; persona_kind: "account" | "buyer";
    persona_status: string; persona_thesis: string | null;
  }>();
  return (r.results ?? []).map((row) => ({
    persona_id: row.persona_id,
    persona_name: row.persona_name,
    persona_kind: row.persona_kind,
    persona_status: row.persona_status,
    persona_thesis: row.persona_thesis,
    fit_score: row.fit_score,
    hard_filter_pass: row.hard_filter_pass,
    components: row.components_json ? (() => { try { return JSON.parse(row.components_json!); } catch { return null; } })() : null,
    explanation: row.explanation,
    explanation_at: row.explanation_at,
    computed_at: row.computed_at,
  }));
}

// ----- entity fact loaders shared by scorer + workflow

export async function loadAccountFacts(env: Env, accountId: string): Promise<{ name: string; facts: AccountFacts; last_modified: string | null } | null> {
  const a = await env.DB.prepare(
    `SELECT id, name, status, domain, hq_country_iso2, size_band, employees, industry, industries_json, funding_stage, updated_at FROM accounts WHERE id = ?`,
  ).bind(accountId).first<{ id: string; name: string; status: string; domain: string | null; hq_country_iso2: string | null; size_band: string | null; employees: number | null; industry: string | null; industries_json: string | null; funding_stage: string | null; updated_at: string | null }>();
  if (!a) return null;
  const tech = await env.DB.prepare(`SELECT vendor FROM account_tech WHERE account_id = ?`).bind(accountId).all<{ vendor: string }>();
  const sigs = await env.DB.prepare(
    `SELECT kind, weight, confidence, occurred_at FROM signals WHERE account_id = ? ORDER BY occurred_at DESC LIMIT 200`,
  ).bind(accountId).all<{ kind: string; weight: number; confidence: number; occurred_at: string }>();
  const buyers = await env.DB.prepare(
    `SELECT id, title, seniority, department, is_decision_maker, updated_at FROM buyers WHERE account_id = ? LIMIT 50`,
  ).bind(accountId).all<{ id: string; title: string | null; seniority: string | null; department: string | null; is_decision_maker: number; updated_at: string | null }>();
  const facts: AccountFacts = {
    status: a.status,
    domain: a.domain,
    hq_country_iso2: a.hq_country_iso2,
    size_band: a.size_band,
    employees: a.employees,
    industry: a.industry,
    industries: parseJsonArr(a.industries_json),
    funding_stage: a.funding_stage,
    techs: (tech.results ?? []).map((t) => t.vendor),
    signals: sigs.results ?? [],
    buyers: (buyers.results ?? []).map((b): BuyerFacts => ({
      account: null, title: b.title, seniority: b.seniority, department: b.department,
      is_decision_maker: b.is_decision_maker, last_modified: b.updated_at,
    })),
    last_modified: a.updated_at,
  };
  return { name: a.name, facts, last_modified: a.updated_at };
}

export async function loadBuyerFacts(env: Env, buyerId: string): Promise<{ name: string; facts: BuyerFacts; last_modified: string | null; account_id: string } | null> {
  const b = await env.DB.prepare(
    `SELECT id, account_id, name, title, seniority, department, is_decision_maker, updated_at FROM buyers WHERE id = ?`,
  ).bind(buyerId).first<{ id: string; account_id: string; name: string | null; title: string | null; seniority: string | null; department: string | null; is_decision_maker: number; updated_at: string | null }>();
  if (!b) return null;
  const acct = await loadAccountFacts(env, b.account_id);
  const facts: BuyerFacts = {
    account: acct?.facts ?? null,
    title: b.title, seniority: b.seniority, department: b.department,
    is_decision_maker: b.is_decision_maker, last_modified: b.updated_at,
  };
  return { name: b.name ?? b.title ?? buyerId, facts, last_modified: b.updated_at, account_id: b.account_id };
}

// Bulk loader for AccountFacts. Issues 4 set-based queries (accounts +
// account_tech + signals + buyers, each with WHERE id IN (?...)) and
// stitches them together. Used by rescorePersonaFull and the
// /preview endpoint to avoid N round-trips over the D1 binding.
export async function loadAccountFactsBulk(env: Env, ids: string[]): Promise<Map<string, { name: string; facts: AccountFacts; last_modified: string | null }>> {
  const out = new Map<string, { name: string; facts: AccountFacts; last_modified: string | null }>();
  if (!ids.length) return out;
  const ph = ids.map(() => "?").join(",");
  const [a, tech, sigs, buyers] = await Promise.all([
    env.DB.prepare(`SELECT id, name, status, domain, hq_country_iso2, size_band, employees, industry, industries_json, funding_stage, updated_at FROM accounts WHERE id IN (${ph})`).bind(...ids).all<{ id: string; name: string; status: string; domain: string | null; hq_country_iso2: string | null; size_band: string | null; employees: number | null; industry: string | null; industries_json: string | null; funding_stage: string | null; updated_at: string | null }>(),
    env.DB.prepare(`SELECT account_id, vendor FROM account_tech WHERE account_id IN (${ph})`).bind(...ids).all<{ account_id: string; vendor: string }>(),
    env.DB.prepare(`SELECT account_id, kind, weight, confidence, occurred_at FROM signals WHERE account_id IN (${ph}) ORDER BY occurred_at DESC`).bind(...ids).all<{ account_id: string; kind: string; weight: number; confidence: number; occurred_at: string }>(),
    env.DB.prepare(`SELECT id, account_id, title, seniority, department, is_decision_maker, updated_at FROM buyers WHERE account_id IN (${ph})`).bind(...ids).all<{ id: string; account_id: string; title: string | null; seniority: string | null; department: string | null; is_decision_maker: number; updated_at: string | null }>(),
  ]);
  const techByAcct = new Map<string, string[]>();
  for (const t of tech.results ?? []) {
    const arr = techByAcct.get(t.account_id) ?? []; arr.push(t.vendor); techByAcct.set(t.account_id, arr);
  }
  const sigByAcct = new Map<string, Array<{ kind: string; weight: number; confidence: number; occurred_at: string }>>();
  for (const s of sigs.results ?? []) {
    const arr = sigByAcct.get(s.account_id) ?? [];
    if (arr.length < 200) arr.push({ kind: s.kind, weight: s.weight, confidence: s.confidence, occurred_at: s.occurred_at });
    sigByAcct.set(s.account_id, arr);
  }
  const buyByAcct = new Map<string, BuyerFacts[]>();
  for (const b of buyers.results ?? []) {
    const arr = buyByAcct.get(b.account_id) ?? [];
    if (arr.length < 50) arr.push({ account: null, title: b.title, seniority: b.seniority, department: b.department, is_decision_maker: b.is_decision_maker, last_modified: b.updated_at });
    buyByAcct.set(b.account_id, arr);
  }
  for (const row of a.results ?? []) {
    const facts: AccountFacts = {
      status: row.status, domain: row.domain, hq_country_iso2: row.hq_country_iso2,
      size_band: row.size_band, employees: row.employees, industry: row.industry,
      industries: parseJsonArr(row.industries_json), funding_stage: row.funding_stage,
      techs: techByAcct.get(row.id) ?? [],
      signals: sigByAcct.get(row.id) ?? [],
      buyers: buyByAcct.get(row.id) ?? [],
      last_modified: row.updated_at,
    };
    out.set(row.id, { name: row.name, facts, last_modified: row.updated_at });
  }
  return out;
}

// Bulk loader for BuyerFacts. Issues 1 query for the buyers + delegates
// to loadAccountFactsBulk for parent accounts (one round-trip via IN).
export async function loadBuyerFactsBulk(env: Env, ids: string[]): Promise<Map<string, { name: string; facts: BuyerFacts; last_modified: string | null; account_id: string }>> {
  const out = new Map<string, { name: string; facts: BuyerFacts; last_modified: string | null; account_id: string }>();
  if (!ids.length) return out;
  const ph = ids.map(() => "?").join(",");
  const r = await env.DB.prepare(`SELECT id, account_id, name, title, seniority, department, is_decision_maker, updated_at FROM buyers WHERE id IN (${ph})`).bind(...ids).all<{ id: string; account_id: string; name: string | null; title: string | null; seniority: string | null; department: string | null; is_decision_maker: number; updated_at: string | null }>();
  const buyerRows = r.results ?? [];
  const acctIds = Array.from(new Set(buyerRows.map((b) => b.account_id)));
  const acctFacts = await loadAccountFactsBulk(env, acctIds);
  for (const b of buyerRows) {
    const acct = acctFacts.get(b.account_id);
    const facts: BuyerFacts = {
      account: acct?.facts ?? null, title: b.title, seniority: b.seniority, department: b.department,
      is_decision_maker: b.is_decision_maker, last_modified: b.updated_at,
    };
    out.set(b.id, { name: b.name ?? b.title ?? b.id, facts, last_modified: b.updated_at, account_id: b.account_id });
  }
  return out;
}

// Bulk writeback: recompute max active-persona fit_score for each id
// in one aggregate query, then UPDATE in one statement per kind. Used
// at the end of each rescore batch instead of N per-row writebacks.
export async function bulkWriteBackFit(env: Env, kind: "account" | "buyer", ids: string[]): Promise<void> {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT pm.entity_id AS id, MAX(pm.fit_score) AS m
       FROM persona_matches pm
       JOIN personas p ON p.id = pm.persona_id
      WHERE pm.entity_kind = ? AND pm.entity_id IN (${ph})
        AND p.status = 'active' AND p.deleted_at IS NULL
      GROUP BY pm.entity_id`,
  ).bind(kind, ...ids).all<{ id: string; m: number | null }>();
  const maxById = new Map<string, number>();
  for (const r of rows.results ?? []) maxById.set(r.id, r.m ?? 0);
  // Issue updates as a batch (each binds its own params; D1 batches
  // these into one HTTP round-trip via the binding's batch() API).
  const stmts = ids.map((id) => {
    const m = maxById.get(id) ?? 0;
    if (kind === "account") {
      return env.DB.prepare(`UPDATE accounts SET fit_score = ?, account_score = ROUND((0.6 * intent_score) + (0.4 * ?), 2) WHERE id = ?`).bind(m, m, id);
    }
    return env.DB.prepare(`UPDATE buyers SET fit_score = ? WHERE id = ?`).bind(m, id);
  });
  await env.DB.batch(stmts);
}

// Materialize a compact "facts" object for the AI explainer.
export function summarizeAccountForExplanation(name: string, f: AccountFacts): Record<string, unknown> {
  return {
    name,
    domain: f.domain,
    industry: f.industry,
    employees: f.employees,
    size_band: f.size_band,
    country: f.hq_country_iso2,
    funding_stage: f.funding_stage,
    top_techs: f.techs.slice(0, 8),
    top_signals: f.signals.slice(0, 5).map((s) => ({ kind: s.kind, weight: s.weight, occurred_at: s.occurred_at })),
    top_buyer: f.buyers[0] ? { title: f.buyers[0].title, seniority: f.buyers[0].seniority } : null,
  };
}

export function summarizeBuyerForExplanation(name: string, f: BuyerFacts): Record<string, unknown> {
  return {
    name,
    title: f.title,
    seniority: f.seniority,
    department: f.department,
    is_decision_maker: !!f.is_decision_maker,
    account: f.account ? summarizeAccountForExplanation(name, f.account) : null,
  };
}
