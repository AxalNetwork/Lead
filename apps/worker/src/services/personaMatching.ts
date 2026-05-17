// Task #8: Real persona matching algorithm.
//
// Deterministic weighted scoring engine that ranks unified `u_entities`
// (person entities) against a persona. Each entity gets a score in
// [0,1] plus a transparent per-component breakdown so the dashboard can
// explain *why* an entity matched.
//
// This service is intentionally separate from `personas/rescore.ts`
// which scores the legacy `accounts`/`buyers` tables. Both coexist:
// the dashboard's Top-Matches pane keeps using the existing flow; the
// new `/api/personas/:id/candidates` endpoint reads from the table
// this service writes (`persona_entity_matches`).
//
// All scoring runs in workflows / queues / cron — never in a public
// read endpoint's hot path. The read endpoint serves precomputed rows.

import type { Env } from "../types";
import { aiEmbed } from "../ai/extract";
import { assertBudget } from "../ai/budget";
import { getPersona, type PersonaRow } from "../personas/repo";
import type { PersonaSpec } from "../personas/score";

// ---------------------------------------------------------------------------
// Constants (tunable in one place per task spec).
// ---------------------------------------------------------------------------
export const MODEL_VERSION = "v1";

export const DEFAULT_WEIGHTS = {
  title_sim: 0.25,
  seniority: 0.15,
  function: 0.15,
  industry: 0.15,
  company_size: 0.10,
  stage: 0.10,
  geo: 0.10,
} as const;

export type ComponentKey = keyof typeof DEFAULT_WEIGHTS;

// Ordered seniority ladder for adjacency scoring. Lower index = junior.
const SENIORITY_LADDER = [
  "ic", "analyst", "associate", "manager", "principal",
  "director", "vp", "svp", "cxo", "founder", "partner",
];
const SENIORITY_INDEX: Record<string, number> = Object.fromEntries(
  SENIORITY_LADDER.map((s, i) => [s, i]),
);

// Ordered funding-stage ladder. Adjacent = 0.6.
const STAGE_LADDER = [
  "pre_seed", "seed", "series_a", "series_b", "series_c",
  "series_d", "growth", "late", "public",
];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGE_LADDER.map((s, i) => [s, i]),
);

// Lightweight parent-industry map (entity industry → persona industry).
// Used so an entity tagged `fintech` partially matches a persona
// targeting `finance`.
const INDUSTRY_PARENTS: Record<string, string[]> = {
  fintech: ["finance"], insurtech: ["finance"], wealthtech: ["finance"],
  proptech: ["realestate"], regtech: ["finance", "compliance"],
  edtech: ["education"], healthtech: ["healthcare"],
  biotech: ["healthcare", "lifesciences"], medtech: ["healthcare"],
  cleantech: ["energy"], climatetech: ["energy"],
  saas: ["software"], devtools: ["software"], paas: ["software"],
  martech: ["marketing"], adtech: ["marketing"],
  agtech: ["agriculture"], foodtech: ["food"],
  legaltech: ["legal"], hrtech: ["hr"],
};

// Continent groups for geo fallback when ISO2 doesn't match exactly.
const CONTINENT: Record<string, string> = {
  us: "na", ca: "na", mx: "na",
  gb: "eu", de: "eu", fr: "eu", es: "eu", it: "eu", nl: "eu", se: "eu", ch: "eu", ie: "eu", pl: "eu", pt: "eu", be: "eu", at: "eu", dk: "eu", no: "eu", fi: "eu",
  cn: "as", jp: "as", in: "as", sg: "as", kr: "as", hk: "as", il: "as", ae: "as",
  br: "sa", ar: "sa", cl: "sa", co: "sa",
  au: "oc", nz: "oc",
  za: "af", ng: "af", ke: "af", eg: "af",
};

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------
export interface ScoreComponentResult {
  value: number;          // 0..1
  weight: number;         // applied weight
  reason: string;         // human-readable
  data?: Record<string, unknown>;
}

export type ComponentMap = Record<ComponentKey, ScoreComponentResult>;

export interface MatchResult {
  score: number;          // 0..1
  components: ComponentMap;
  rationale: string;
}

export interface PersonEntity {
  id: string;
  display_name: string | null;
  country_iso2: string | null;
  region: string | null;
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

export interface PersonaTargets {
  title_text: string;             // joined text for embedding
  titles: string[];
  seniority: string[];
  functions: string[];
  industries: string[];
  size_min: number | null;
  size_max: number | null;
  stages: string[];
  geos: string[];                  // ISO2 codes
}

// ---------------------------------------------------------------------------
// Pure scorers (one per component, [0..1]).
// ---------------------------------------------------------------------------
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

export function scoreSeniority(entity: string | null, targets: string[]): ScoreComponentResult {
  if (!entity || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.seniority, reason: "no seniority data" };
  }
  const e = entity.toLowerCase().trim();
  const ei = SENIORITY_INDEX[e];
  if (ei === undefined) {
    return { value: 0, weight: DEFAULT_WEIGHTS.seniority, reason: `unknown seniority "${entity}"` };
  }
  let best = 0; let bestTarget = "";
  for (const t of targets) {
    const ti = SENIORITY_INDEX[t.toLowerCase().trim()];
    if (ti === undefined) continue;
    const d = Math.abs(ei - ti);
    let v = 0;
    if (d === 0) v = 1.0;
    else if (d === 1) v = 0.6;
    else if (d === 2) v = 0.2;
    if (v > best) { best = v; bestTarget = t; }
  }
  return {
    value: best, weight: DEFAULT_WEIGHTS.seniority,
    reason: best === 1 ? `exact seniority match (${entity})`
      : best > 0 ? `seniority ${entity} ≈ target ${bestTarget}`
      : `seniority ${entity} too far from targets`,
  };
}

function stem(token: string): string {
  // Light stemming: trim trailing s/es/ing/ed; lowercase.
  let t = token.toLowerCase().replace(/[^a-z]/g, "");
  if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith("ed") && t.length > 4) t = t.slice(0, -2);
  else if (t.endsWith("es") && t.length > 4) t = t.slice(0, -2);
  else if (t.endsWith("s") && t.length > 3) t = t.slice(0, -1);
  return t;
}
function tokenSet(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(/[\s,/&-]+/).map(stem).filter((t) => t.length > 1));
}

export function scoreFunction(entityDept: string | null, targets: string[]): ScoreComponentResult {
  if (!entityDept || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.function, reason: "no function/dept data" };
  }
  const ent = tokenSet(entityDept);
  let best = 0; let bestTarget = "";
  for (const t of targets) {
    const tgt = tokenSet(t);
    if (!tgt.size) continue;
    let hits = 0;
    for (const tok of tgt) if (ent.has(tok)) hits++;
    const jacc = hits / Math.max(1, new Set([...ent, ...tgt]).size);
    if (jacc > best) { best = jacc; bestTarget = t; }
  }
  return {
    value: Math.min(1, best * 1.5), // amplify partial overlaps slightly
    weight: DEFAULT_WEIGHTS.function,
    reason: best > 0 ? `function "${entityDept}" overlaps "${bestTarget}"` : `function "${entityDept}" no overlap`,
  };
}

export function scoreIndustry(entityIndustries: string[], targets: string[]): ScoreComponentResult {
  if (!entityIndustries.length || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.industry, reason: "no industry data" };
  }
  const tset = new Set(targets.map((t) => t.toLowerCase()));
  let best = 0; let bestNote = "";
  for (const ei of entityIndustries) {
    const e = ei.toLowerCase();
    if (tset.has(e)) { best = 1.0; bestNote = `industry "${ei}" matches target`; break; }
    const parents = INDUSTRY_PARENTS[e] ?? [];
    for (const p of parents) {
      if (tset.has(p)) {
        if (best < 0.7) { best = 0.7; bestNote = `industry "${ei}" ⊂ target "${p}"`; }
      }
    }
  }
  if (!bestNote) bestNote = `industries [${entityIndustries.join(",")}] don't match targets`;
  return { value: best, weight: DEFAULT_WEIGHTS.industry, reason: bestNote };
}

export function scoreCompanySize(emp: number | null, minE: number | null, maxE: number | null): ScoreComponentResult {
  if (emp == null || (minE == null && maxE == null)) {
    return { value: 0, weight: DEFAULT_WEIGHTS.company_size, reason: "company size unknown" };
  }
  const lo = minE ?? 0;
  const hi = maxE ?? Number.POSITIVE_INFINITY;
  if (emp >= lo && emp <= hi) {
    return { value: 1.0, weight: DEFAULT_WEIGHTS.company_size, reason: `headcount ${emp} in target [${lo}, ${maxE ?? "∞"}]` };
  }
  // Adjacent: within 50% of the boundary.
  const dLo = emp < lo ? (lo - emp) / Math.max(1, lo) : 0;
  const dHi = emp > hi ? (emp - hi) / Math.max(1, hi) : 0;
  const d = Math.max(dLo, dHi);
  if (d <= 0.5) return { value: 0.5, weight: DEFAULT_WEIGHTS.company_size, reason: `headcount ${emp} adjacent to target` };
  return { value: 0, weight: DEFAULT_WEIGHTS.company_size, reason: `headcount ${emp} outside target [${lo}, ${maxE ?? "∞"}]` };
}

export function scoreStage(entityStages: string[], targets: string[]): ScoreComponentResult {
  if (!entityStages.length || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.stage, reason: "stage unknown" };
  }
  let best = 0; let note = "";
  for (const e of entityStages) {
    const ei = STAGE_INDEX[e.toLowerCase().replace(/[-\s]/g, "_")];
    if (ei === undefined) continue;
    for (const t of targets) {
      const ti = STAGE_INDEX[t.toLowerCase().replace(/[-\s]/g, "_")];
      if (ti === undefined) continue;
      const d = Math.abs(ei - ti);
      let v = 0;
      if (d === 0) v = 1.0;
      else if (d === 1) v = 0.6;
      if (v > best) { best = v; note = d === 0 ? `stage ${e} matches target` : `stage ${e} adjacent to ${t}`; }
    }
  }
  return { value: best, weight: DEFAULT_WEIGHTS.stage, reason: note || `stages [${entityStages.join(",")}] don't match targets` };
}

export function scoreGeo(entityIso2: string | null, targets: string[]): ScoreComponentResult {
  if (!entityIso2 || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.geo, reason: "geo unknown" };
  }
  const e = entityIso2.toLowerCase();
  const t = targets.map((x) => x.toLowerCase());
  if (t.includes(e)) {
    return { value: 1.0, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} matches target` };
  }
  // Region/continent fallback: 0.5 if any target shares a continent.
  const ec = CONTINENT[e];
  if (ec) {
    for (const tc of t) if (CONTINENT[tc] === ec) {
      return { value: 0.5, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} shares region with target ${tc.toUpperCase()}` };
    }
  }
  return { value: 0, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} not in targets [${targets.join(",")}]` };
}

// ---------------------------------------------------------------------------
// Persona target extraction from PersonaRow.
// ---------------------------------------------------------------------------
function arrFromJson(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function objFromJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

export function extractTargets(row: PersonaRow): PersonaTargets {
  const hard = objFromJson(row.hard_filters_json);
  const stagesFromHard = Array.isArray(hard.stages) ? (hard.stages as unknown[]).filter((x) => typeof x === "string") as string[]
    : Array.isArray(hard.target_stage) ? (hard.target_stage as unknown[]).filter((x) => typeof x === "string") as string[]
    : [];
  const titles = arrFromJson(row.buyer_titles_json);
  const seniority = arrFromJson(row.buyer_seniority_json);
  const functions = arrFromJson(row.buyer_departments_json);
  const industries = arrFromJson(row.industries_json);
  const geos = arrFromJson(row.geos_json);
  const title_text = [
    titles.join(", "),
    seniority.length ? `Seniority: ${seniority.join(", ")}` : "",
    functions.length ? `Function: ${functions.join(", ")}` : "",
    row.thesis ? `Thesis: ${row.thesis}` : "",
  ].filter(Boolean).join(". ");
  return {
    title_text,
    titles,
    seniority,
    functions,
    industries,
    size_min: row.size_min ?? null,
    size_max: row.size_max ?? null,
    stages: stagesFromHard,
    geos,
  };
}

// ---------------------------------------------------------------------------
// Entity loader: pulls a person entity + its current employer's facts
// from the unified graph in a small number of queries.
// ---------------------------------------------------------------------------
async function loadEmployerFacts(env: Env, employerId: string): Promise<{
  name: string | null; country: string | null; sectors: string[]; stages: string[]; employees: number | null;
} | null> {
  const sum = await env.DB.prepare(
    `SELECT display_name, country_iso2, sectors_csv, stages_csv FROM entity_summary WHERE entity_id = ?`,
  ).bind(employerId).first<{ display_name: string | null; country_iso2: string | null; sectors_csv: string | null; stages_csv: string | null }>();
  // Pull headcount from facts (predicate variants).
  const hc = await env.DB.prepare(
    `SELECT value_number FROM facts WHERE entity_id = ? AND is_current = 1 AND predicate IN ('org.headcount','org.employees','company.employees','company.headcount') AND value_number IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,
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
  // Current career row (is_current=1, fall back to most recent ended_at).
  const career = await env.DB.prepare(
    `SELECT role_title, seniority, department, organization_entity_id, organization_name
       FROM career_history
      WHERE entity_id = ?
      ORDER BY is_current DESC, COALESCE(ended_at, '9999') DESC, started_at DESC
      LIMIT 1`,
  ).bind(entityId).first<{ role_title: string | null; seniority: string | null; department: string | null; organization_entity_id: string | null; organization_name: string | null }>();
  // Title fallback from facts when career_history is empty.
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
  return {
    id: ent.id,
    display_name: ent.display_name,
    country_iso2: sum?.country_iso2 ?? null,
    region: sum?.region ?? null,
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
// Title similarity: cached embeddings via existing aiEmbed + R2 cache.
// ---------------------------------------------------------------------------
async function titleSimilarity(env: Env, personaText: string, entityTitle: string | null): Promise<ScoreComponentResult> {
  if (!entityTitle || !personaText) {
    return { value: 0, weight: DEFAULT_WEIGHTS.title_sim, reason: "missing title" };
  }
  // Graceful degrade when AI binding is absent: fall back to token overlap.
  if (!env.AI) {
    const ov = scoreFunction(entityTitle, [personaText]); // re-use Jaccard
    return { value: ov.value, weight: DEFAULT_WEIGHTS.title_sim, reason: `title token overlap (no embed): ${ov.reason}` };
  }
  try {
    const [pv, ev] = await Promise.all([aiEmbed(env, personaText), aiEmbed(env, entityTitle)]);
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
// Compose final MatchResult.
// ---------------------------------------------------------------------------
function aggregate(components: ComponentMap): number {
  let sum = 0; let wsum = 0;
  for (const k of Object.keys(components) as ComponentKey[]) {
    const c = components[k];
    sum += c.value * c.weight;
    wsum += c.weight;
  }
  return wsum > 0 ? sum / wsum : 0;
}
function buildRationale(personaName: string, entity: PersonEntity, components: ComponentMap, score: number): string {
  const pct = Math.round(score * 100);
  const top = (Object.entries(components) as Array<[ComponentKey, ScoreComponentResult]>)
    .map(([k, c]) => ({ k, contribution: c.value * c.weight, reason: c.reason }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((x) => x.reason)
    .join("; ");
  const who = entity.display_name ?? entity.id;
  const where = entity.employer_name ? ` at ${entity.employer_name}` : "";
  return `${who}${where} scores ${pct}% against persona "${personaName}". Top drivers: ${top}.`;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
export async function scoreEntityForPersona(env: Env, persona: PersonaRow, entity: PersonEntity): Promise<MatchResult> {
  const targets = extractTargets(persona);
  const [title_sim, seniority, fnc, industry, company_size, stage, geo] = await Promise.all([
    titleSimilarity(env, targets.title_text || targets.titles.join(", "), entity.title),
    Promise.resolve(scoreSeniority(entity.seniority, targets.seniority)),
    Promise.resolve(scoreFunction(entity.department, targets.functions)),
    Promise.resolve(scoreIndustry(entity.employer_sectors, targets.industries)),
    Promise.resolve(scoreCompanySize(entity.employer_employees, targets.size_min, targets.size_max)),
    Promise.resolve(scoreStage(entity.employer_stages, targets.stages)),
    Promise.resolve(scoreGeo(entity.country_iso2 ?? entity.employer_country, targets.geos)),
  ]);
  const components: ComponentMap = { title_sim, seniority, function: fnc, industry, company_size, stage, geo };
  const score = aggregate(components);
  const rationale = buildRationale(persona.name, entity, components, score);
  return { score, components, rationale };
}

export async function scoreEntity(env: Env, personaId: string, entityId: string): Promise<MatchResult | null> {
  const persona = await getPersona(env, personaId);
  if (!persona) return null;
  const entity = await loadPersonEntity(env, entityId);
  if (!entity) return null;
  // Budget guard for the embedding call inside titleSimilarity.
  await assertBudget(env, "ai").catch(() => undefined);
  const result = await scoreEntityForPersona(env, persona, entity);
  await upsertMatch(env, personaId, entityId, result);
  return result;
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
  // Auto-scoring never overwrites manual rows.
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
  // Manual upsert: replace whatever's there.
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

export async function scoreEntityAcrossPersonas(env: Env, entityId: string): Promise<{ scored: number; errors: number }> {
  const entity = await loadPersonEntity(env, entityId);
  if (!entity) return { scored: 0, errors: 0 };
  const r = await env.DB.prepare(
    `SELECT * FROM personas WHERE deleted_at IS NULL AND status = 'active'`,
  ).all<PersonaRow>();
  let scored = 0; let errors = 0;
  for (const p of r.results ?? []) {
    try {
      const res = await scoreEntityForPersona(env, p, entity);
      await upsertMatch(env, p.id, entityId, res);
      scored += 1;
    } catch (e) {
      errors += 1;
      console.warn("scoreEntityAcrossPersonas item failed", p.id, entityId, (e as Error).message);
    }
  }
  return { scored, errors };
}

// Batch a persona against every active person entity in pages.
export async function scoreBatch(env: Env, personaId: string, opts: { batchSize?: number; maxEntities?: number; cancelKey?: string } = {}): Promise<{ scored: number; errors: number; pages: number }> {
  const persona = await getPersona(env, personaId);
  if (!persona) return { scored: 0, errors: 0, pages: 0 };
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 100), 500);
  const maxEntities = Math.max(0, opts.maxEntities ?? 20000);
  let offset = 0; let scored = 0; let errors = 0; let pages = 0;
  while (scored + errors < maxEntities) {
    const r = await env.DB.prepare(
      `SELECT id FROM u_entities WHERE kind = 'person' AND status = 'active' ORDER BY id LIMIT ? OFFSET ?`,
    ).bind(batchSize, offset).all<{ id: string }>();
    const ids = (r.results ?? []).map((x) => x.id);
    if (!ids.length) break;
    pages += 1;
    for (const id of ids) {
      try {
        const entity = await loadPersonEntity(env, id);
        if (!entity) continue;
        const res = await scoreEntityForPersona(env, persona, entity);
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
  return { scored, errors, pages };
}

// Nightly refresh: re-score rows whose last_scored_at is older than
// `staleDays` (default 30). Operates page by page across personas so a
// single tick never blows the budget.
export async function refreshStaleMatches(env: Env, opts: { staleDays?: number; limit?: number } = {}): Promise<{ refreshed: number; errors: number }> {
  const staleDays = Math.max(1, opts.staleDays ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 5000);
  const r = await env.DB.prepare(
    `SELECT persona_id, entity_id FROM persona_entity_matches
      WHERE source = 'auto' AND datetime(last_scored_at) < datetime('now', ?)
      ORDER BY last_scored_at ASC LIMIT ?`,
  ).bind(`-${staleDays} days`, limit).all<{ persona_id: string; entity_id: string }>();
  let refreshed = 0; let errors = 0;
  for (const row of r.results ?? []) {
    try {
      const res = await scoreEntity(env, row.persona_id, row.entity_id);
      if (res) refreshed += 1;
    } catch (e) {
      errors += 1;
      console.warn("refreshStaleMatches item failed", row.persona_id, row.entity_id, (e as Error).message);
    }
  }
  return { refreshed, errors };
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

// Re-export for tests / callers that want the spec type.
export type { PersonaSpec };
