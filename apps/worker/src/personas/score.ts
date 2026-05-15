// Task #46: deterministic persona scoring.
//
// fit_score = clamp(0..100, recency_boost * Σ w_i * c_i) when hard
// filters pass, else 0. Components are each 0..100. semantic_fit comes
// from cosine similarity against the entity's existing embedding (we
// pass it in pre-computed); the rest are computed here from row data.

export const DEFAULT_WEIGHTS_ACCOUNT = {
  size: 0.10,
  geo: 0.10,
  industry: 0.20,
  tech: 0.10,
  signal: 0.20,
  buyer: 0.10,
  semantic: 0.20,
} as const;

export const DEFAULT_WEIGHTS_BUYER = {
  size: 0.05,
  geo: 0.05,
  industry: 0.15,
  tech: 0.05,
  signal: 0.10,
  buyer: 0.45,
  semantic: 0.15,
} as const;

export type WeightKey = keyof typeof DEFAULT_WEIGHTS_ACCOUNT;

export interface PersonaSpec {
  id: string;
  kind: "account" | "buyer";
  size_min: number | null;
  size_max: number | null;
  size_bands: string[];
  geos: string[];
  industries: string[];
  techs_required: string[];
  techs_preferred: string[];
  techs_excluded: string[];
  signal_kinds: string[];
  buyer_titles: string[];
  buyer_seniority: string[];
  buyer_departments: string[];
  hard_filters: Record<string, unknown>;
  weights: Partial<Record<WeightKey, number>>;
  semantic_fit_threshold: number;
  recency_boost: number;
}

export interface AccountFacts {
  status: string;
  domain: string | null;
  hq_country_iso2: string | null;
  size_band: string | null;
  employees: number | null;
  industry: string | null;
  industries: string[];
  funding_stage: string | null;
  techs: string[];                 // lowercase vendor slugs from account_tech
  signals: Array<{ kind: string; weight: number; confidence: number; occurred_at: string }>;
  buyers: Array<BuyerFacts>;
  last_modified: string | null;
}

export interface BuyerFacts {
  account: AccountFacts | null;    // null when scored standalone
  title: string | null;
  seniority: string | null;
  department: string | null;
  is_decision_maker: number;
  last_modified: string | null;
}

export interface ScoreComponents {
  hard_filter_pass: number;        // 0/1
  size_fit: number;
  geo_fit: number;
  industry_fit: number;
  tech_fit: number;
  signal_fit: number;
  buyer_fit: number;
  semantic_fit: number;
  recency_boost: number;
  weights: Record<string, number>;
  reasons: string[];               // human-readable per-component notes
}

export interface ScoreResult {
  fit_score: number;               // 0..100
  components: ScoreComponents;
}

const DAY = 86_400_000;

function lc(s: string | null | undefined): string { return (s ?? "").toLowerCase().trim(); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

function scoreSize(p: PersonaSpec, emp: number | null, band: string | null): number {
  if (p.size_min == null && p.size_max == null && p.size_bands.length === 0) return 50;
  if (band && p.size_bands.length && p.size_bands.includes(band)) return 100;
  if (emp == null) return 25;
  const lo = p.size_min ?? 0;
  const hi = p.size_max ?? Number.MAX_SAFE_INTEGER;
  if (emp >= lo && emp <= hi) return 100;
  // Soft penalty: 25% per order-of-magnitude away.
  const ratio = emp < lo ? lo / Math.max(1, emp) : emp / hi;
  const decades = Math.log10(ratio);
  return Math.max(0, 100 - Math.round(decades * 60));
}

function scoreGeo(p: PersonaSpec, iso: string | null): number {
  if (!p.geos.length) return 50;
  if (!iso) return 20;
  const i = lc(iso);
  if (p.geos.includes(i)) return 100;
  // Region bucketing
  const REGION: Record<string, string[]> = {
    emea: ["gb","ie","fr","de","es","it","nl","be","se","no","fi","dk","pt","pl","ch","at"],
    apac: ["jp","sg","au","nz","kr","in","hk","tw","my","id","ph","th","vn"],
    latam: ["br","mx","ar","cl","co","pe","uy"],
    africa: ["za","ng","ke","eg","ma"],
  };
  for (const slug of p.geos) {
    const ctry = REGION[slug];
    if (ctry && ctry.includes(i)) return 80;
    if (slug === "global") return 60;
  }
  return 0;
}

function scoreIndustry(p: PersonaSpec, primary: string | null, all: string[]): number {
  if (!p.industries.length) return 50;
  const want = new Set(p.industries.map(lc));
  if (primary && want.has(lc(primary))) return 100;
  for (const i of all.map(lc)) if (want.has(i)) return 80;
  return 0;
}

function scoreTech(p: PersonaSpec, techs: string[]): { score: number; pass: boolean } {
  const have = new Set(techs.map(lc));
  if (p.techs_excluded.some((t) => have.has(lc(t)))) return { score: 0, pass: false };
  if (p.techs_required.length) {
    const all = p.techs_required.every((t) => have.has(lc(t)));
    if (!all) return { score: 0, pass: false };
  }
  if (!p.techs_preferred.length && !p.techs_required.length) return { score: 50, pass: true };
  const matched = p.techs_preferred.filter((t) => have.has(lc(t))).length;
  const ratio = p.techs_preferred.length ? matched / p.techs_preferred.length : 1;
  return { score: Math.round(60 + 40 * ratio), pass: true };
}

function scoreSignals(p: PersonaSpec, sigs: AccountFacts["signals"]): number {
  if (!sigs.length) return 0;
  const want = new Set(p.signal_kinds.map(lc));
  const now = Date.now();
  let totalCredit = 0;
  for (const s of sigs) {
    const t = Date.parse(s.occurred_at);
    const age = Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : 365;
    const decay = Math.exp(-age / 30);                        // half-life-ish
    const w = (s.weight ?? 0) * (s.confidence ?? 1);
    const kindMul = want.size === 0 ? 0.5 : want.has(lc(s.kind)) ? 1.0 : 0.25;
    totalCredit += w * decay * kindMul;
  }
  return Math.round(100 * (1 - Math.exp(-totalCredit / 15)));
}

function scoreBuyer(p: PersonaSpec, b: BuyerFacts): number {
  let s = 0;
  let denom = 0;
  if (p.buyer_titles.length) {
    denom += 50;
    const t = lc(b.title);
    if (t && p.buyer_titles.some((x) => t.includes(lc(x)))) s += 50;
  }
  if (p.buyer_seniority.length) {
    denom += 30;
    if (b.seniority && p.buyer_seniority.includes(lc(b.seniority))) s += 30;
  }
  if (p.buyer_departments.length) {
    denom += 20;
    if (b.department && p.buyer_departments.includes(lc(b.department))) s += 20;
  }
  if (denom === 0) return 50;
  // Decision-maker bonus
  if (b.is_decision_maker) s = Math.min(denom, s + 5);
  return Math.round((s / denom) * 100);
}

function scoreBuyersForAccount(p: PersonaSpec, buyers: BuyerFacts[]): number {
  if (!buyers.length) return p.buyer_titles.length || p.buyer_seniority.length ? 0 : 50;
  let best = 0;
  for (const b of buyers) best = Math.max(best, scoreBuyer(p, b));
  return best;
}

export function checkHardFilters(p: PersonaSpec, account: AccountFacts | null, buyer: BuyerFacts | null): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const f = p.hard_filters || {};
  const acc = account ?? buyer?.account ?? null;
  if (f.require_domain && acc && !acc.domain) { reasons.push("missing_domain"); return { pass: false, reasons }; }
  if (Array.isArray(f.statuses_in) && acc && !(f.statuses_in as string[]).map(lc).includes(lc(acc.status))) {
    reasons.push(`status_not_in:${acc.status}`); return { pass: false, reasons };
  }
  if (Array.isArray(f.exclude_country_iso2) && acc && acc.hq_country_iso2 && (f.exclude_country_iso2 as string[]).map(lc).includes(lc(acc.hq_country_iso2))) {
    reasons.push(`country_excluded:${acc.hq_country_iso2}`); return { pass: false, reasons };
  }
  if (Array.isArray(f.country_iso2_in) && acc && (!acc.hq_country_iso2 || !(f.country_iso2_in as string[]).map(lc).includes(lc(acc.hq_country_iso2)))) {
    reasons.push("country_not_in"); return { pass: false, reasons };
  }
  if (Array.isArray(f.funding_stage_in) && acc && (!acc.funding_stage || !(f.funding_stage_in as string[]).map(lc).includes(lc(acc.funding_stage)))) {
    reasons.push("funding_stage_not_in"); return { pass: false, reasons };
  }
  if (f.is_decision_maker && buyer && !buyer.is_decision_maker) { reasons.push("not_decision_maker"); return { pass: false, reasons }; }
  return { pass: true, reasons };
}

export function recencyBoost(p: PersonaSpec, lastModifiedISO: string | null): number {
  // Override wins; otherwise small boost (max 1.15x) for entities updated
  // within the last 7 days. Capped 1.0..1.2 per spec.
  if (p.recency_boost && p.recency_boost > 0) return clamp(p.recency_boost, 1.0, 1.2);
  if (!lastModifiedISO) return 1.0;
  const t = Date.parse(lastModifiedISO);
  if (!Number.isFinite(t)) return 1.0;
  const ageDays = Math.max(0, (Date.now() - t) / DAY);
  if (ageDays <= 7) return 1.15;
  if (ageDays <= 30) return 1.05;
  return 1.0;
}

export function scoreEntity(
  p: PersonaSpec,
  ctx: { account: AccountFacts | null; buyer: BuyerFacts | null; semanticCosine?: number | null },
): ScoreResult {
  const reasons: string[] = [];
  const hf = checkHardFilters(p, ctx.account, ctx.buyer);
  if (!hf.pass) {
    return {
      fit_score: 0,
      components: {
        hard_filter_pass: 0, size_fit: 0, geo_fit: 0, industry_fit: 0, tech_fit: 0,
        signal_fit: 0, buyer_fit: 0, semantic_fit: 0, recency_boost: 1,
        weights: { ...(p.kind === "account" ? DEFAULT_WEIGHTS_ACCOUNT : DEFAULT_WEIGHTS_BUYER), ...p.weights },
        reasons: hf.reasons,
      },
    };
  }
  const acc = ctx.account ?? ctx.buyer?.account ?? null;
  const tech = scoreTech(p, acc?.techs ?? []);
  if (!tech.pass) {
    reasons.push("tech_excluded_or_missing_required");
    return {
      fit_score: 0,
      components: {
        hard_filter_pass: 1, size_fit: 0, geo_fit: 0, industry_fit: 0, tech_fit: 0,
        signal_fit: 0, buyer_fit: 0, semantic_fit: 0, recency_boost: 1,
        weights: { ...(p.kind === "account" ? DEFAULT_WEIGHTS_ACCOUNT : DEFAULT_WEIGHTS_BUYER), ...p.weights },
        reasons,
      },
    };
  }
  const size = scoreSize(p, acc?.employees ?? null, acc?.size_band ?? null);
  const geo = scoreGeo(p, acc?.hq_country_iso2 ?? null);
  const industry = scoreIndustry(p, acc?.industry ?? null, acc?.industries ?? []);
  const signal = scoreSignals(p, acc?.signals ?? []);
  const buyerScore = ctx.buyer ? scoreBuyer(p, ctx.buyer) : scoreBuyersForAccount(p, acc?.buyers ?? []);
  const semCos = typeof ctx.semanticCosine === "number" ? ctx.semanticCosine : null;
  const semantic = semCos == null
    ? 50
    : semCos < (p.semantic_fit_threshold ?? 0.55) ? 0 : Math.round(clamp((semCos - 0.4) / 0.5, 0, 1) * 100);

  const w = { ...(p.kind === "account" ? DEFAULT_WEIGHTS_ACCOUNT : DEFAULT_WEIGHTS_BUYER), ...p.weights };
  const sumW = (w.size ?? 0) + (w.geo ?? 0) + (w.industry ?? 0) + (w.tech ?? 0) + (w.signal ?? 0) + (w.buyer ?? 0) + (w.semantic ?? 0);
  const norm = sumW > 0 ? sumW : 1;
  const blended =
    ((size * (w.size ?? 0)) +
     (geo * (w.geo ?? 0)) +
     (industry * (w.industry ?? 0)) +
     (tech.score * (w.tech ?? 0)) +
     (signal * (w.signal ?? 0)) +
     (buyerScore * (w.buyer ?? 0)) +
     (semantic * (w.semantic ?? 0))) / norm;
  const boost = recencyBoost(p, ctx.buyer?.last_modified ?? acc?.last_modified ?? null);
  const fit = Math.round(clamp(blended * boost, 0, 100));

  return {
    fit_score: fit,
    components: {
      hard_filter_pass: 1,
      size_fit: size,
      geo_fit: geo,
      industry_fit: industry,
      tech_fit: tech.score,
      signal_fit: signal,
      buyer_fit: buyerScore,
      semantic_fit: semantic,
      recency_boost: boost,
      weights: w,
      reasons,
    },
  };
}

export function buildEmbeddingText(p: PersonaSpec & { name: string; thesis: string | null }): string {
  const parts: string[] = [];
  parts.push(`Persona: ${p.name}`);
  if (p.thesis) parts.push(`Thesis: ${p.thesis}`);
  if (p.industries.length) parts.push(`Industries: ${p.industries.join(", ")}`);
  if (p.geos.length) parts.push(`Geos: ${p.geos.join(", ")}`);
  if (p.size_min || p.size_max) parts.push(`Size: ${p.size_min ?? "?"}–${p.size_max ?? "?"} FTE`);
  if (p.techs_required.length) parts.push(`Required tech: ${p.techs_required.join(", ")}`);
  if (p.techs_preferred.length) parts.push(`Preferred tech: ${p.techs_preferred.join(", ")}`);
  if (p.signal_kinds.length) parts.push(`Watch signals: ${p.signal_kinds.join(", ")}`);
  if (p.buyer_titles.length) parts.push(`Buyer titles: ${p.buyer_titles.join(", ")}`);
  if (p.buyer_seniority.length) parts.push(`Buyer seniority: ${p.buyer_seniority.join(", ")}`);
  if (p.buyer_departments.length) parts.push(`Buyer departments: ${p.buyer_departments.join(", ")}`);
  return parts.join(" | ");
}
