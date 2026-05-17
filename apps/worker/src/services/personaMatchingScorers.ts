// Task #8: Pure scoring primitives for the persona ↔ entity matcher.
//
// This module is intentionally free of D1 / Env / AI imports so it can
// be unit-tested in node:test (see test/personaMatching.test.mjs). The
// orchestrator (services/personaMatching.ts) wires these primitives to
// the database, embeddings, and workflow dispatch.

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

const SENIORITY_LADDER = [
  "ic", "analyst", "associate", "manager", "principal",
  "director", "vp", "svp", "cxo", "founder", "partner",
];
const SENIORITY_INDEX: Record<string, number> = Object.fromEntries(
  SENIORITY_LADDER.map((s, i) => [s, i]),
);

const STAGE_LADDER = [
  "pre_seed", "seed", "series_a", "series_b", "series_c",
  "series_d", "growth", "late", "public",
];
const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGE_LADDER.map((s, i) => [s, i]),
);

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

const CONTINENT: Record<string, string> = {
  us: "na", ca: "na", mx: "na",
  gb: "eu", de: "eu", fr: "eu", es: "eu", it: "eu", nl: "eu", se: "eu", ch: "eu", ie: "eu", pl: "eu", pt: "eu", be: "eu", at: "eu", dk: "eu", no: "eu", fi: "eu",
  cn: "as", jp: "as", in: "as", sg: "as", kr: "as", hk: "as", il: "as", ae: "as",
  br: "sa", ar: "sa", cl: "sa", co: "sa",
  au: "oc", nz: "oc",
  za: "af", ng: "af", ke: "af", eg: "af",
};

// Rough country centroids (lat, lng) used as a fallback when an entity
// has an ISO2 country but no precise coordinates. Only the most common
// targets are populated; absent entries skip the Haversine path and
// fall back to ISO2 + continent.
const COUNTRY_CENTROID: Record<string, [number, number]> = {
  us: [39.8, -98.6], ca: [56.1, -106.3], mx: [23.6, -102.5],
  gb: [54.0, -2.0],  de: [51.2, 10.4],   fr: [46.6, 2.2],
  es: [40.4, -3.7],  it: [41.9, 12.5],   nl: [52.1, 5.3],
  se: [60.1, 18.6],  ch: [46.8, 8.2],    ie: [53.1, -7.7],
  cn: [35.9, 104.2], jp: [36.2, 138.2],  in: [20.6, 78.9],
  sg: [1.35, 103.8], kr: [35.9, 127.8],  il: [31.0, 34.9],
  br: [-14.2, -51.9], au: [-25.3, 133.8], nz: [-40.9, 174.9],
  za: [-30.6, 22.9], ng: [9.1, 8.7],
};

export interface ScoreComponentResult {
  value: number;
  weight: number;
  reason: string;
  data?: Record<string, unknown>;
}

export type ComponentMap = Record<ComponentKey, ScoreComponentResult>;

export interface MatchResult {
  score: number;
  components: ComponentMap;
  rationale: string;
}

export interface PersonaTargets {
  title_text: string;
  titles: string[];
  seniority: string[];
  functions: string[];
  industries: string[];
  size_min: number | null;
  size_max: number | null;
  stages: string[];
  geos: string[];
  geo_center_lat: number | null;
  geo_center_lng: number | null;
  geo_radius_km: number | null;
}

// ---------------------------------------------------------------------------
// Cosine similarity (exported for the embedding-driven title_sim).
// ---------------------------------------------------------------------------
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

// ---------------------------------------------------------------------------
// Component scorers (each returns a value in [0, 1]).
// ---------------------------------------------------------------------------
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
    value: Math.min(1, best * 1.5),
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

// ---------------------------------------------------------------------------
// Geo: Haversine + exponential decay when coordinates are present; ISO2
// + continent fallback otherwise.
// ---------------------------------------------------------------------------
const EARTH_KM = 6371;
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface GeoInput {
  entityIso2: string | null;
  entityLat?: number | null;
  entityLng?: number | null;
  targets: string[];           // persona target ISO2 codes
  centerLat?: number | null;   // persona geo center
  centerLng?: number | null;
  radiusKm?: number | null;    // persona radius
}

export function scoreGeo(input: GeoInput): ScoreComponentResult {
  const { entityIso2, targets } = input;
  const hasCenter = input.centerLat != null && input.centerLng != null && (input.radiusKm ?? 0) > 0;
  // Coordinate path: Haversine + exp(-d/radius) decay.
  let entLat = input.entityLat ?? null;
  let entLng = input.entityLng ?? null;
  if ((entLat == null || entLng == null) && entityIso2) {
    const c = COUNTRY_CENTROID[entityIso2.toLowerCase()];
    if (c) { entLat = c[0]; entLng = c[1]; }
  }
  if (hasCenter && entLat != null && entLng != null) {
    const d = haversineKm(input.centerLat!, input.centerLng!, entLat, entLng);
    const v = Math.max(0, Math.min(1, Math.exp(-d / Math.max(1, input.radiusKm!))));
    return {
      value: v,
      weight: DEFAULT_WEIGHTS.geo,
      reason: `geo ${d.toFixed(0)}km from persona center (radius ${input.radiusKm}km) ⇒ ${v.toFixed(2)}`,
      data: { distance_km: d, radius_km: input.radiusKm },
    };
  }
  // ISO2 fallback.
  if (!entityIso2 || !targets.length) {
    return { value: 0, weight: DEFAULT_WEIGHTS.geo, reason: "geo unknown" };
  }
  const e = entityIso2.toLowerCase();
  const t = targets.map((x) => x.toLowerCase());
  if (t.includes(e)) {
    return { value: 1.0, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} matches target` };
  }
  const ec = CONTINENT[e];
  if (ec) {
    for (const tc of t) if (CONTINENT[tc] === ec) {
      return { value: 0.5, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} shares region with target ${tc.toUpperCase()}` };
    }
  }
  return { value: 0, weight: DEFAULT_WEIGHTS.geo, reason: `geo ${entityIso2} not in targets [${targets.join(",")}]` };
}

// ---------------------------------------------------------------------------
// Aggregation + rationale.
// ---------------------------------------------------------------------------
export function aggregate(components: ComponentMap): number {
  let sum = 0; let wsum = 0;
  for (const k of Object.keys(components) as ComponentKey[]) {
    const c = components[k];
    sum += c.value * c.weight;
    wsum += c.weight;
  }
  return wsum > 0 ? sum / wsum : 0;
}

export function buildRationale(personaName: string, entityName: string | null, employerName: string | null, components: ComponentMap, score: number): string {
  const pct = Math.round(score * 100);
  const top = (Object.entries(components) as Array<[ComponentKey, ScoreComponentResult]>)
    .map(([k, c]) => ({ k, contribution: c.value * c.weight, reason: c.reason }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((x) => x.reason)
    .join("; ");
  const who = entityName ?? "entity";
  const where = employerName ? ` at ${employerName}` : "";
  return `${who}${where} scores ${pct}% against persona "${personaName}". Top drivers: ${top}.`;
}

// ---------------------------------------------------------------------------
// Persona target extraction. Accepts a row shape — keeps this file
// free of any `PersonaRow` import from the repo layer.
// ---------------------------------------------------------------------------
export interface PersonaRowLite {
  name: string;
  thesis: string | null;
  buyer_titles_json: string | null;
  buyer_seniority_json: string | null;
  buyer_departments_json: string | null;
  industries_json: string | null;
  size_min: number | null;
  size_max: number | null;
  geos_json: string | null;
  hard_filters_json: string | null;
}

function arrFromJson(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function objFromJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

export function extractTargets(row: PersonaRowLite): PersonaTargets {
  const hard = objFromJson(row.hard_filters_json);
  const stagesFromHard = Array.isArray(hard.stages) ? (hard.stages as unknown[]).filter((x) => typeof x === "string") as string[]
    : Array.isArray(hard.target_stage) ? (hard.target_stage as unknown[]).filter((x) => typeof x === "string") as string[]
    : [];
  const center = hard.geo_center && typeof hard.geo_center === "object" ? hard.geo_center as Record<string, unknown> : {};
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
    geo_center_lat: typeof center.lat === "number" ? center.lat : null,
    geo_center_lng: typeof center.lng === "number" ? center.lng : null,
    geo_radius_km: typeof center.radius_km === "number" ? center.radius_km
      : typeof hard.radius_km === "number" ? hard.radius_km : null,
  };
}
