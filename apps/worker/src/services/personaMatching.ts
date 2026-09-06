// Task #8: Real persona matching algorithm.
//
// Deterministic weighted scoring engine that ranks unified `u_entities`
// (person entities) against a persona. Each entity gets a score in
// [0,1] plus a transparent per-component breakdown so the dashboard
// can explain *why* an entity matched.
//
// Pure scoring primitives live in personaMatchingScorers.ts (no Env
// imports — unit-testable). This module orchestrates the D1 loads,
// the title embedding, and the upsert.

import type { Env } from "../types";
import { aiEmbed } from "../ai/extract";
import { assertBudget } from "../ai/budget";
import { getPersona, type PersonaRow } from "../personas/repo";
import type { PersonaSpec } from "../personas/score";
import {
  DEFAULT_WEIGHTS, MODEL_VERSION, type ComponentKey, type ComponentMap, type ScoreComponentResult as _ScoreComponentResult,
  type MatchResult, type ScoreComponentResult, type PersonaTargets,
  cosine, aggregate, buildRationale, extractTargets,
  scoreSeniority, scoreFunction, scoreIndustry, scoreCompanySize, scoreStage, scoreGeo,
} from "./personaMatchingScorers";

export { DEFAULT_WEIGHTS, MODEL_VERSION, extractTargets };
export type { MatchResult, ComponentMap, ComponentKey, ScoreComponentResult, PersonaTargets };

// Task #3: structural-only fallback used when a kind plugin returns
// null (e.g. fund/company targets that have no per-entity scoring
// pipeline). Builds a properly-typed ComponentMap with zeroed
// components so downstream consumers (rationale builder, persistence)
// don't have to special-case the structural row. Replaces an earlier
// `as unknown as MatchResult` cast that bypassed the type system.
export function buildStructuralFallback(reason: string): MatchResult {
  const components = {} as ComponentMap;
  for (const key of Object.keys(DEFAULT_WEIGHTS) as ComponentKey[]) {
    components[key] = { value: 0, weight: 0, reason: "n/a (structural fallback)" } satisfies _ScoreComponentResult;
  }
  return { score: 0.5, components, rationale: reason };
}

export interface PersonEntity {
  id: string;
  display_name: string | null;
  country_iso2: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  title: string | null;
  seniority: string | null;
  department: string | null;
  employer_entity_id: string | null;
  employer_name: string | null;
  employer_country: string | null;
  employer_sectors: string[];
  employer_stages: string[];
  employer_employees: number | null;
}

// ---------------------------------------------------------------------------
// Entity loader.
// ---------------------------------------------------------------------------
async function loadEmployerFacts(env: Env, employerId: string): Promise<{
  name: string | null; country: string | null; sectors: string[]; stages: string[]; employees: number | null;
} | null> {
  const sum = await env.DB.prepare(
    `SELECT display_name, country_iso2, sectors_csv, stages_csv FROM entity_summary WHERE entity_id = ?`,
  ).bind(employerId).first<{ display_name: string | null; country_iso2: string | null; sectors_csv: string | null; stages_csv: string | null }>();
  // `employees` is first because it is the only one of these that anything
  // writes: it is the predicate the registry declares
  // (entities/profile-predicates.ts) and the one secEdgar/persist.ts and the
  // account dual-write emit. The four `org.*` / `company.*` spellings below
  // were the entire list, and no writer has ever produced one — so
  // `employees` came back null for every entity and scoreCompanySize
  // returned its "company size unknown" zero every time. With a weight of
  // 0.10 that put a hard ceiling of 0.90 on every persona match, and made
  // "company size unknown" a permanent line in the rationale the dashboard
  // shows to explain why someone matched. The unused spellings are kept so a
  // future writer picking one still resolves.
  const hc = await env.DB.prepare(
    `SELECT value_number FROM facts WHERE entity_id = ? AND is_current = 1 AND predicate IN ('employees','org.headcount','org.employees','company.employees','company.headcount') AND value_number IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,
  ).bind(employerId).first<{ value_number: number | null }>();
  if (!sum && !hc) return null;
  return {
    name: sum?.display_name ?? null,
    country: sum?.country_iso2 ?? null,
    sectors: sum?.sectors_csv ? sum.sectors_csv.split(",").map((s) => s.trim()).filter(Boolean) : [],
    stages: sum?.stages_csv ? sum.stages_csv.split(",").map((s) => s.trim()).filter(Boolean) : [],
    employees: hc?.value_number != null ? Math.round(hc.value_number) : null,
  };
}

async function loadEntityCoords(env: Env, entityId: string): Promise<{ lat: number | null; lng: number | null }> {
  const r = await env.DB.prepare(
    `SELECT predicate, value_number FROM facts
      WHERE entity_id = ? AND is_current = 1
        AND predicate IN ('person.location.lat','person.location.lng','geo.lat','geo.lng','location.lat','location.lng')
        AND value_number IS NOT NULL`,
  ).bind(entityId).all<{ predicate: string; value_number: number }>();
  let lat: number | null = null; let lng: number | null = null;
  for (const row of r.results ?? []) {
    if (lat == null && (row.predicate.endsWith(".lat") || row.predicate === "geo.lat")) lat = row.value_number;
    if (lng == null && (row.predicate.endsWith(".lng") || row.predicate === "geo.lng")) lng = row.value_number;
  }
  return { lat, lng };
}

export async function loadPersonEntity(env: Env, entityId: string): Promise<PersonEntity | null> {
  const ent = await env.DB.prepare(
    `SELECT id, display_name, kind, status FROM u_entities WHERE id = ?`,
  ).bind(entityId).first<{ id: string; display_name: string | null; kind: string; status: string }>();
  if (!ent) return null;
  if (ent.kind !== "person") return null;
  if (ent.status === "merged" || ent.status === "soft_deleted") return null;
  const sum = await env.DB.prepare(
    `SELECT country_iso2, region FROM entity_summary WHERE entity_id = ?`,
  ).bind(entityId).first<{ country_iso2: string | null; region: string | null }>();
  const career = await env.DB.prepare(
    `SELECT role_title, seniority, department, organization_entity_id, organization_name
       FROM career_history
      WHERE entity_id = ?
      ORDER BY is_current DESC, COALESCE(ended_at, '9999') DESC, started_at DESC
      LIMIT 1`,
  ).bind(entityId).first<{ role_title: string | null; seniority: string | null; department: string | null; organization_entity_id: string | null; organization_name: string | null }>();
  let title = career?.role_title ?? null;
  if (!title) {
    const tf = await env.DB.prepare(
      `SELECT value_text FROM facts WHERE entity_id = ? AND is_current = 1 AND predicate IN ('person.title','title') AND value_text IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,
    ).bind(entityId).first<{ value_text: string | null }>();
    title = tf?.value_text ?? null;
  }
  let employer: Awaited<ReturnType<typeof loadEmployerFacts>> = null;
  if (career?.organization_entity_id) {
    try { employer = await loadEmployerFacts(env, career.organization_entity_id); } catch { /* ignore */ }
  }
  const coords = await loadEntityCoords(env, entityId).catch(() => ({ lat: null, lng: null }));
  return {
    id: ent.id,
    display_name: ent.display_name,
    country_iso2: sum?.country_iso2 ?? null,
    region: sum?.region ?? null,
    lat: coords.lat,
    lng: coords.lng,
    title,
    seniority: career?.seniority ?? null,
    department: career?.department ?? null,
    employer_entity_id: career?.organization_entity_id ?? null,
    employer_name: employer?.name ?? career?.organization_name ?? null,
    employer_country: employer?.country ?? null,
    employer_sectors: employer?.sectors ?? [],
    employer_stages: employer?.stages ?? [],
    employer_employees: employer?.employees ?? null,
  };
}

// ---------------------------------------------------------------------------
// Title similarity (only DB/Env-touching scorer).
//
// Embeddings are cached in persona_title_embeddings + entity_title_embeddings
// keyed by content_hash so the hot path becomes a D1 lookup instead of an
// AI.embed call. AI.embed only fires on cache miss (new persona, new entity,
// or title text change). This mirrors the Vectorize precompute/reuse
// pattern from Task #7 personas while staying on D1.
// ---------------------------------------------------------------------------
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureTitleCacheTables(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS persona_title_embeddings (persona_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, vector_json TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'bge-base-en-v1.5', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS entity_title_embeddings (entity_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, vector_json TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'bge-base-en-v1.5', updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
  } catch { /* best-effort */ }
}

async function getOrEmbedTitle(
  env: Env,
  scope: "persona" | "entity",
  id: string,
  text: string,
): Promise<number[] | null> {
  const hash = await sha256Hex(text);
  const table = scope === "persona" ? "persona_title_embeddings" : "entity_title_embeddings";
  const idCol = scope === "persona" ? "persona_id" : "entity_id";
  try {
    const row = await env.DB.prepare(
      `SELECT vector_json FROM ${table} WHERE ${idCol} = ? AND content_hash = ?`,
    ).bind(id, hash).first<{ vector_json: string }>();
    if (row?.vector_json) {
      try {
        const v = JSON.parse(row.vector_json);
        if (Array.isArray(v) && v.length) return v as number[];
      } catch { /* fall through to re-embed */ }
    }
  } catch {
    // Table missing — create it once and continue with embedding path.
    await ensureTitleCacheTables(env);
  }
  if (!env.AI) return null;
  const vec = await aiEmbed(env, text);
  if (vec && vec.length) {
    try {
      await env.DB.prepare(
        `INSERT INTO ${table} (${idCol}, content_hash, vector_json, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(${idCol}) DO UPDATE SET content_hash=excluded.content_hash, vector_json=excluded.vector_json, updated_at=excluded.updated_at`,
      ).bind(id, hash, JSON.stringify(vec)).run();
    } catch (e) {
      console.warn("title embedding cache write failed", scope, id, (e as Error).message);
    }
  }
  return vec;
}

async function titleSimilarity(env: Env, personaId: string, personaText: string, entityId: string, entityTitle: string | null): Promise<ScoreComponentResult> {
  if (!entityTitle || !personaText) {
    return { value: 0, weight: DEFAULT_WEIGHTS.title_sim, reason: "missing title" };
  }
  if (!env.AI) {
    const ov = scoreFunction(entityTitle, [personaText]);
    return { value: ov.value, weight: DEFAULT_WEIGHTS.title_sim, reason: `title token overlap (no embed): ${ov.reason}` };
  }
  try {
    const [pv, ev] = await Promise.all([
      getOrEmbedTitle(env, "persona", personaId, personaText),
      getOrEmbedTitle(env, "entity", entityId, entityTitle),
    ]);
    if (!pv || !ev) {
      return { value: 0, weight: DEFAULT_WEIGHTS.title_sim, reason: "embedding unavailable" };
    }
    const c = cosine(pv, ev);
    return { value: c, weight: DEFAULT_WEIGHTS.title_sim, reason: `title cosine ${c.toFixed(3)} ("${entityTitle}")`, data: { cosine: c } };
  } catch (e) {
    return { value: 0, weight: DEFAULT_WEIGHTS.title_sim, reason: `embed error: ${(e as Error).message.slice(0, 60)}` };
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
export async function scoreEntityForPersona(env: Env, persona: PersonaRow, entity: PersonEntity): Promise<MatchResult> {
  const targets = extractTargets(persona);
  const [title_sim, seniority, fnc, industry, company_size, stage, geo] = await Promise.all([
    titleSimilarity(env, persona.id, targets.title_text || targets.titles.join(", "), entity.id, entity.title),
    Promise.resolve(scoreSeniority(entity.seniority, targets.seniority)),
    Promise.resolve(scoreFunction(entity.department, targets.functions)),
    Promise.resolve(scoreIndustry(entity.employer_sectors, targets.industries)),
    Promise.resolve(scoreCompanySize(entity.employer_employees, targets.size_min, targets.size_max)),
    Promise.resolve(scoreStage(entity.employer_stages, targets.stages)),
    Promise.resolve(scoreGeo({
      entityIso2: entity.country_iso2 ?? entity.employer_country,
      entityLat: entity.lat, entityLng: entity.lng,
      targets: targets.geos,
      centerLat: targets.geo_center_lat, centerLng: targets.geo_center_lng,
      radiusKm: targets.geo_radius_km,
    })),
  ]);
  const components: ComponentMap = { title_sim, seniority, function: fnc, industry, company_size, stage, geo };
  const score = aggregate(components);
  const rationale = buildRationale(persona.name, entity.display_name, entity.employer_name, components, score);
  return { score, components, rationale };
}

export async function scoreEntity(env: Env, personaId: string, entityId: string): Promise<MatchResult | null> {
  const persona = await getPersona(env, personaId);
  if (!persona) return null;
  const entity = await loadPersonEntity(env, entityId);
  if (!entity) return null;
  // Task #2 budget gate: refuse if AI cap reached (title_sim uses AI.embed).
  const b = await assertBudget(env, "ai");
  if (!b.ok) {
    await recordMatchJob(env, "score_entity", "halted", { personaId, entityId, reason: b.reason });
    return null;
  }
  const result = await scoreEntityForPersona(env, persona, entity);
  await upsertMatch(env, personaId, entityId, result);
  return result;
}

// Task #8: durable job/error log so SLO violations are visible. Created
// on demand by triggering migrations; CREATE TABLE IF NOT EXISTS guards
// against pre-migration calls.
async function ensureJobsTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS persona_match_jobs (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         status TEXT NOT NULL,
         persona_id TEXT,
         entity_id TEXT,
         details_json TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    ).run();
  } catch { /* best-effort */ }
}

export async function recordMatchJob(
  env: Env,
  kind: "dispatch" | "score_entity" | "score_batch" | "score_across_personas" | "refresh_stale" | "trigger",
  status: "ok" | "halted" | "failed" | "cancelled",
  details: Record<string, unknown>,
): Promise<void> {
  await ensureJobsTable(env);
  try {
    await env.DB.prepare(
      `INSERT INTO persona_match_jobs (id, kind, status, persona_id, entity_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), kind, status,
      (details.personaId as string | undefined) ?? null,
      (details.entityId as string | undefined) ?? null,
      JSON.stringify(details),
    ).run();
  } catch (e) {
    console.warn("recordMatchJob failed", kind, status, (e as Error).message);
  }
}

async function isCancelled(env: Env, jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  try {
    const r = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    return r?.status === "cancelled" || r?.status === "timed_out";
  } catch { return false; }
}

export interface UpsertOpts { source?: "auto" | "manual" }

export async function upsertMatch(env: Env, personaId: string, entityId: string, result: MatchResult, opts: UpsertOpts = {}): Promise<void> {
  const source = opts.source ?? "auto";
  const evidence = JSON.stringify({
    components: Object.fromEntries((Object.keys(result.components) as ComponentKey[]).map((k) => [k, {
      value: Number(result.components[k].value.toFixed(4)),
      weight: result.components[k].weight,
      reason: result.components[k].reason,
    }])),
    rationale: result.rationale,
    weights: DEFAULT_WEIGHTS,
    version: MODEL_VERSION,
  });
  if (source === "auto") {
    await env.DB.prepare(
      `INSERT INTO persona_entity_matches (persona_id, entity_id, score, match_evidence_json, source, last_scored_at, model_version)
       VALUES (?, ?, ?, ?, 'auto', datetime('now'), ?)
       ON CONFLICT(persona_id, entity_id) DO UPDATE SET
         score = CASE WHEN persona_entity_matches.source = 'manual' THEN persona_entity_matches.score ELSE excluded.score END,
         match_evidence_json = CASE WHEN persona_entity_matches.source = 'manual' THEN persona_entity_matches.match_evidence_json ELSE excluded.match_evidence_json END,
         last_scored_at = excluded.last_scored_at,
         model_version = CASE WHEN persona_entity_matches.source = 'manual' THEN persona_entity_matches.model_version ELSE excluded.model_version END`,
    ).bind(personaId, entityId, result.score, evidence, MODEL_VERSION).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO persona_entity_matches (persona_id, entity_id, score, match_evidence_json, source, last_scored_at, model_version)
     VALUES (?, ?, ?, ?, 'manual', datetime('now'), ?)
     ON CONFLICT(persona_id, entity_id) DO UPDATE SET
       score = excluded.score,
       match_evidence_json = excluded.match_evidence_json,
       source = 'manual',
       last_scored_at = excluded.last_scored_at,
       model_version = excluded.model_version`,
  ).bind(personaId, entityId, result.score, evidence, MODEL_VERSION).run();
}

export async function scoreEntityAcrossPersonas(env: Env, entityId: string, opts: { jobId?: string | null } = {}): Promise<{ scored: number; errors: number; halted: boolean }> {
  const entity = await loadPersonEntity(env, entityId);
  if (!entity) return { scored: 0, errors: 0, halted: false };
  const r = await env.DB.prepare(
    `SELECT * FROM personas WHERE deleted_at IS NULL AND status = 'active'`,
  ).all<PersonaRow>();
  let scored = 0; let errors = 0; let halted = false;
  for (const p of r.results ?? []) {
    // Task #2: budget + cancellation enforcement per item.
    const b = await assertBudget(env, "ai");
    if (!b.ok) {
      halted = true;
      await recordMatchJob(env, "score_across_personas", "halted", { entityId, scored, errors, reason: b.reason });
      break;
    }
    if (await isCancelled(env, opts.jobId ?? null)) {
      halted = true;
      await recordMatchJob(env, "score_across_personas", "cancelled", { entityId, scored, errors });
      break;
    }
    try {
      const res = await scoreEntityForPersona(env, p, entity);
      await upsertMatch(env, p.id, entityId, res);
      scored += 1;
    } catch (e) {
      errors += 1;
      console.warn("scoreEntityAcrossPersonas item failed", p.id, entityId, (e as Error).message);
    }
  }
  return { scored, errors, halted };
}

export async function scoreBatch(env: Env, personaId: string, opts: { batchSize?: number; maxEntities?: number | null; jobId?: string | null } = {}): Promise<{ scored: number; errors: number; pages: number; halted: boolean }> {
  const persona = await getPersona(env, personaId);
  if (!persona) return { scored: 0, errors: 0, pages: 0, halted: false };
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 100), 500);
  // maxEntities = null (default) means "process every active person
  // entity" — the task requires create/edit dispatch covers all
  // entities, not a hardcoded cap. Operators can pass a number when
  // they want to bound a manual run.
  const maxEntities = opts.maxEntities ?? null;
  let offset = 0; let scored = 0; let errors = 0; let pages = 0; let halted = false;
  for (;;) {
    if (maxEntities != null && scored + errors >= maxEntities) break;
    // Task #2: budget + cancellation check per page (cheap, bounded).
    const b = await assertBudget(env, "ai");
    if (!b.ok) {
      halted = true;
      await recordMatchJob(env, "score_batch", "halted", { personaId, scored, errors, pages, reason: b.reason });
      break;
    }
    if (await isCancelled(env, opts.jobId ?? null)) {
      halted = true;
      await recordMatchJob(env, "score_batch", "cancelled", { personaId, scored, errors, pages });
      break;
    }
    // Task #3: dispatch through the kind plugin so each persona kind
    // selects its own candidate pool (e.g. investor_person filters
    // entity_roles.role IN ('investor','vc','gp','partner_at_firm')).
    // Note: explicit .js extension here is required by tsconfig.test.json's
    // NodeNext moduleResolution. The wrangler build / typecheck doesn't
    // care; this is purely to unblock `pnpm test`.
    const { getPluginFor } = await import("./personas/kinds/index.js");
    const plugin = getPluginFor(persona.kind);
    const filter = plugin.defaultEntityFilter(persona, { limit: batchSize, offset });
    const r = await env.DB.prepare(filter.sql).bind(...filter.binds).all<{ id: string }>();
    const ids = (r.results ?? []).map((x) => x.id);
    if (!ids.length) break;
    pages += 1;
    for (const id of ids) {
      try {
        // Task #3: delegate to the kind plugin so bespoke matchers
        // (investor_firm structural, venture_partner subtype, etc.)
        // get the chance to override scoring. The generic plugin's
        // scoreEntity returns the person-graph score for person
        // targets and null for fund/company targets — when null, we
        // persist a deterministic structural-match row at score 50
        // so non-person kinds still surface candidates in the UI.
        let res = await plugin.scoreEntity(env, persona, id);
        if (!res) res = buildStructuralFallback(plugin.explainMatch(id));
        await upsertMatch(env, personaId, id, res);
        scored += 1;
      } catch (e) {
        errors += 1;
        console.warn("scoreBatch item failed", personaId, id, (e as Error).message);
      }
    }
    if (ids.length < batchSize) break;
    offset += batchSize;
  }
  if (errors > 0 && !halted) {
    await recordMatchJob(env, "score_batch", "ok", { personaId, scored, errors, pages });
  }
  return { scored, errors, pages, halted };
}

export async function refreshStaleMatches(env: Env, opts: { staleDays?: number; limit?: number; jobId?: string | null } = {}): Promise<{ refreshed: number; errors: number; halted: boolean }> {
  const staleDays = Math.max(1, opts.staleDays ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 5000);
  const r = await env.DB.prepare(
    `SELECT persona_id, entity_id FROM persona_entity_matches
      WHERE source = 'auto' AND datetime(last_scored_at) < datetime('now', ?)
      ORDER BY last_scored_at ASC LIMIT ?`,
  ).bind(`-${staleDays} days`, limit).all<{ persona_id: string; entity_id: string }>();
  let refreshed = 0; let errors = 0; let halted = false;
  for (const row of r.results ?? []) {
    // Task #2: per-item budget + cancellation gate.
    const b = await assertBudget(env, "ai");
    if (!b.ok) {
      halted = true;
      await recordMatchJob(env, "refresh_stale", "halted", { refreshed, errors, reason: b.reason });
      break;
    }
    if (await isCancelled(env, opts.jobId ?? null)) {
      halted = true;
      await recordMatchJob(env, "refresh_stale", "cancelled", { refreshed, errors });
      break;
    }
    try {
      const res = await scoreEntity(env, row.persona_id, row.entity_id);
      if (res) refreshed += 1;
    } catch (e) {
      errors += 1;
      console.warn("refreshStaleMatches item failed", row.persona_id, row.entity_id, (e as Error).message);
    }
  }
  return { refreshed, errors, halted };
}

// ---------------------------------------------------------------------------
// Read API used by GET /api/personas/:id/candidates.
// ---------------------------------------------------------------------------
export interface CandidateRow {
  persona_id: string;
  entity_id: string;
  score: number;
  source: "auto" | "manual";
  last_scored_at: string;
  model_version: string;
  components: Record<string, { value: number; weight: number; reason: string }>;
  rationale: string;
  entity_name: string | null;
  entity_domain: string | null;
  entity_country: string | null;
}

export async function listCandidates(env: Env, personaId: string, opts: { minScore?: number; limit?: number; offset?: number }): Promise<CandidateRow[]> {
  const minScore = Math.max(0, Math.min(1, opts.minScore ?? 0));
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const offset = Math.max(0, opts.offset ?? 0);
  const r = await env.DB.prepare(
    `SELECT pem.persona_id, pem.entity_id, pem.score, pem.source, pem.last_scored_at, pem.model_version, pem.match_evidence_json,
            ue.display_name AS entity_name, ue.primary_domain AS entity_domain,
            es.country_iso2 AS entity_country
       FROM persona_entity_matches pem
       JOIN u_entities ue ON ue.id = pem.entity_id
       LEFT JOIN entity_summary es ON es.entity_id = pem.entity_id
      WHERE pem.persona_id = ? AND pem.score >= ?
      ORDER BY pem.score DESC, pem.last_scored_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(personaId, minScore, limit, offset).all<{
    persona_id: string; entity_id: string; score: number; source: "auto" | "manual";
    last_scored_at: string; model_version: string; match_evidence_json: string | null;
    entity_name: string | null; entity_domain: string | null; entity_country: string | null;
  }>();
  return (r.results ?? []).map((row) => {
    let components: Record<string, { value: number; weight: number; reason: string }> = {};
    let rationale = "";
    if (row.match_evidence_json) {
      try {
        const j = JSON.parse(row.match_evidence_json) as { components?: typeof components; rationale?: string };
        if (j.components) components = j.components;
        if (typeof j.rationale === "string") rationale = j.rationale;
      } catch { /* ignore */ }
    }
    return {
      persona_id: row.persona_id,
      entity_id: row.entity_id,
      score: row.score,
      source: row.source,
      last_scored_at: row.last_scored_at,
      model_version: row.model_version,
      components,
      rationale,
      entity_name: row.entity_name,
      entity_domain: row.entity_domain,
      entity_country: row.entity_country,
    };
  });
}

export type { PersonaSpec };
