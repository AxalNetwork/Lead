// Task #51: deterministic ICP fit scoring.
//
// Computes accounts.fit_score (0..100) from five components, each scored
// 0..100 and combined as a weighted average:
//
//   industry  (0.25) — account.industry / industries_json vs ICP industries
//   size      (0.20) — size_band / employees vs ICP sizing
//   geo       (0.20) — hq_country_iso2 vs ICP country list
//   funding   (0.15) — funding_stage vs ICP stage list
//   buyer     (0.20) — % of ICP target roles that have a matching buyer
//                      (role_slug or seniority/department fallback)
//
// The blended account_score = 0.6*intent + 0.4*fit lives in score.ts;
// this module only owns the fit half. Intent stays untouched.
//
// Until per-ICP scoring lands (the optional half of the task), every
// account is scored against `DEFAULT_ICP` — a baked-in profile that
// matches the seeded personas (mid-market data/AI buyers in NA/EU).
// `computeFit` accepts an `icp` arg so a future per-ICP loop can call
// it for each row in the `icps`/`personas` table without reshaping.

import type { AccountRow, BuyerRow } from "./repo";

export interface IcpProfile {
  industries: string[];          // lowercased slugs / labels
  size_bands: string[];          // accepted size_band literals
  size_min: number | null;       // employees lower bound (inclusive)
  size_max: number | null;       // employees upper bound (inclusive)
  geos_iso2: string[];           // uppercased ISO-3166-1 alpha-2
  funding_stages: string[];      // lowercased stage slugs
  target_roles: string[];        // role_taxonomy.slug values we want covered
  weights: {
    industry: number;
    size: number;
    geo: number;
    funding: number;
    buyer: number;
  };
}

export const DEFAULT_ICP: IcpProfile = {
  industries: [
    "saas","fintech","ai","ai_infrastructure","developer_tools",
    "data","analytics","ecommerce","martech","devops","security",
  ],
  size_bands: ["51-200","201-500","501-1000","1001-5000"],
  size_min: 50,
  size_max: 5000,
  geos_iso2: ["US","CA","GB","IE","DE","FR","NL","SE","DK","NO","FI","ES","IT","AU","NZ","SG"],
  funding_stages: ["seed","series_a","series_b","series_c","growth","ipo"],
  target_roles: ["cto","cdo","vp_engineering","vp_data","director_data","head_of_data","director_engineering"],
  weights: { industry: 0.25, size: 0.20, geo: 0.20, funding: 0.15, buyer: 0.20 },
};

export interface FitComponent {
  name: "industry" | "size" | "geo" | "funding" | "buyer";
  score: number;          // 0..100
  weight: number;         // matches IcpProfile.weights
  contribution: number;   // score * weight (so the dashboard can sum)
  reason: string;         // short human-readable explanation
}

export interface FitResult {
  fit_score: number;                 // 0..100, weighted avg of components
  components: FitComponent[];
  icp_id: string;                    // identifier of the ICP used
  icp_name: string;
  computed_at: string;               // ISO timestamp
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()).filter(Boolean) : [];
  } catch { return []; }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function scoreIndustry(account: AccountRow, icp: IcpProfile): FitComponent {
  const want = new Set(icp.industries.map(norm).filter(Boolean));
  const have = new Set<string>();
  if (account.industry) have.add(norm(account.industry));
  for (const s of parseJsonArray(account.industries_json)) have.add(s);
  if (!want.size) return { name: "industry", score: 50, weight: icp.weights.industry, contribution: 50 * icp.weights.industry, reason: "No ICP industries defined; neutral 50." };
  if (!have.size) return { name: "industry", score: 0, weight: icp.weights.industry, contribution: 0, reason: "Account has no industry tagged." };
  let matches = 0;
  for (const h of have) if (want.has(h)) matches += 1;
  if (matches === 0) {
    // Partial credit if any account industry shares a token with any ICP slug
    const tokens = new Set<string>();
    for (const w of want) for (const t of w.split(/[\s_/-]+/)) if (t.length > 2) tokens.add(t);
    let partial = 0;
    for (const h of have) for (const t of h.split(/[\s_/-]+/)) if (tokens.has(t)) { partial = 1; break; }
    const score = partial ? 25 : 0;
    return { name: "industry", score, weight: icp.weights.industry, contribution: round2(score * icp.weights.industry),
      reason: partial ? `Loose token overlap with ${[...want].slice(0,3).join(", ")}` : `No overlap with ${[...want].slice(0,3).join(", ")}…` };
  }
  // Full match if any direct intersection. Bonus capped at 100 for multiple matches.
  const score = Math.min(100, 70 + matches * 15);
  return { name: "industry", score, weight: icp.weights.industry, contribution: round2(score * icp.weights.industry),
    reason: `${matches} industry match${matches === 1 ? "" : "es"} (${[...have].filter((h) => want.has(h)).slice(0,3).join(", ")}).` };
}

function scoreSize(account: AccountRow, icp: IcpProfile): FitComponent {
  const w = icp.weights.size;
  const sb = norm(account.size_band);
  const emp = typeof account.employees === "number" && account.employees > 0 ? account.employees : null;
  const bandMatch = sb && icp.size_bands.map(norm).includes(sb);
  const minOk = icp.size_min == null || (emp != null && emp >= icp.size_min);
  const maxOk = icp.size_max == null || (emp != null && emp <= icp.size_max);
  if (bandMatch && (emp == null || (minOk && maxOk))) {
    return { name: "size", score: 100, weight: w, contribution: round2(100 * w), reason: `Size band ${sb} is in ICP range.` };
  }
  if (emp != null && minOk && maxOk) {
    return { name: "size", score: 85, weight: w, contribution: round2(85 * w), reason: `${emp} employees fits ICP range.` };
  }
  if (emp != null) {
    // Soft taper outside the band
    const lo = icp.size_min ?? 0;
    const hi = icp.size_max ?? Number.POSITIVE_INFINITY;
    const dist = emp < lo ? (lo - emp) / Math.max(lo, 1) : (emp - hi) / Math.max(hi, 1);
    const score = Math.max(0, Math.round(60 - dist * 60));
    return { name: "size", score, weight: w, contribution: round2(score * w),
      reason: `${emp} employees outside ICP range ${icp.size_min ?? "?"}–${icp.size_max ?? "?"}.` };
  }
  if (sb) {
    return { name: "size", score: 30, weight: w, contribution: round2(30 * w), reason: `Size band ${sb} not in ICP target bands.` };
  }
  return { name: "size", score: 0, weight: w, contribution: 0, reason: "No size data on account." };
}

function scoreGeo(account: AccountRow, icp: IcpProfile): FitComponent {
  const w = icp.weights.geo;
  const c = (account.hq_country_iso2 ?? "").toUpperCase();
  if (!icp.geos_iso2.length) return { name: "geo", score: 50, weight: w, contribution: round2(50 * w), reason: "No ICP geos defined; neutral 50." };
  if (!c) return { name: "geo", score: 0, weight: w, contribution: 0, reason: "No HQ country on account." };
  if (icp.geos_iso2.map((x) => x.toUpperCase()).includes(c)) {
    return { name: "geo", score: 100, weight: w, contribution: round2(100 * w), reason: `HQ ${c} is in ICP geos.` };
  }
  return { name: "geo", score: 0, weight: w, contribution: 0, reason: `HQ ${c} not in ICP geos.` };
}

function scoreFunding(account: AccountRow, icp: IcpProfile): FitComponent {
  const w = icp.weights.funding;
  const stage = norm(account.funding_stage);
  if (!icp.funding_stages.length) return { name: "funding", score: 50, weight: w, contribution: round2(50 * w), reason: "No ICP funding stages defined; neutral 50." };
  if (!stage) return { name: "funding", score: 30, weight: w, contribution: round2(30 * w), reason: "No funding stage tagged." };
  if (icp.funding_stages.map(norm).includes(stage)) {
    return { name: "funding", score: 100, weight: w, contribution: round2(100 * w), reason: `Stage ${stage} is in ICP.` };
  }
  return { name: "funding", score: 20, weight: w, contribution: round2(20 * w), reason: `Stage ${stage} not in ICP.` };
}

export interface RoleTaxonomyRow {
  slug: string;
  department: string | null;
  seniority: string | null;
  decision_maker: number;
  aliases_json: string | null;
}

function scoreBuyerCoverage(buyers: BuyerRow[], icp: IcpProfile, taxonomy: Map<string, RoleTaxonomyRow>): FitComponent {
  const w = icp.weights.buyer;
  if (!icp.target_roles.length) {
    return { name: "buyer", score: 50, weight: w, contribution: round2(50 * w), reason: "No ICP target roles defined; neutral 50." };
  }
  if (!buyers.length) {
    return { name: "buyer", score: 0, weight: w, contribution: 0, reason: "No buyers tracked." };
  }
  const wanted = icp.target_roles.map(norm);
  const buyerSlugs = new Set(buyers.map((b) => norm(b.role_slug)).filter(Boolean));
  const covered: string[] = [];
  const fallback: string[] = [];
  for (const role of wanted) {
    if (buyerSlugs.has(role)) { covered.push(role); continue; }
    // Fallback: match by seniority+department from taxonomy entry
    const tax = taxonomy.get(role);
    if (!tax) continue;
    const dept = norm(tax.department);
    const sen = norm(tax.seniority);
    const match = buyers.some((b) => {
      const bd = norm(b.department); const bs = norm(b.seniority);
      if (dept && bd === dept && sen && bs === sen) return true;
      // Title contains alias
      const aliases = parseJsonArray(tax.aliases_json);
      const title = norm(b.title);
      if (title && aliases.some((a) => a && title.includes(a))) return true;
      return false;
    });
    if (match) fallback.push(role);
  }
  const total = wanted.length;
  const fullPts = covered.length;
  const partialPts = fallback.length * 0.6;
  const ratio = (fullPts + partialPts) / total;
  const score = Math.min(100, Math.round(ratio * 100));
  const parts: string[] = [];
  if (covered.length) parts.push(`exact: ${covered.join(", ")}`);
  if (fallback.length) parts.push(`fuzzy: ${fallback.join(", ")}`);
  if (!parts.length) parts.push(`none of ${wanted.slice(0, 3).join(", ")}…`);
  return { name: "buyer", score, weight: w, contribution: round2(score * w), reason: `${fullPts}/${total} target roles covered (${parts.join("; ")}).` };
}

export function computeFit(
  account: AccountRow,
  buyers: BuyerRow[],
  taxonomy: Map<string, RoleTaxonomyRow>,
  icp: IcpProfile = DEFAULT_ICP,
  icpMeta: { id: string; name: string } = { id: "default", name: "Default ICP" },
): FitResult {
  const components: FitComponent[] = [
    scoreIndustry(account, icp),
    scoreSize(account, icp),
    scoreGeo(account, icp),
    scoreFunding(account, icp),
    scoreBuyerCoverage(buyers, icp, taxonomy),
  ];
  const weightSum = components.reduce((a, c) => a + c.weight, 0) || 1;
  const fit = components.reduce((a, c) => a + c.score * c.weight, 0) / weightSum;
  return {
    fit_score: round2(Math.max(0, Math.min(100, fit))),
    components,
    icp_id: icpMeta.id,
    icp_name: icpMeta.name,
    computed_at: new Date().toISOString(),
  };
}

// Convenience for tests / cron self-check.
export function _selfCheck(): boolean {
  const a: AccountRow = {
    id: "x", name: "Acme", legal_name: null, domain: "acme.com", website: null, logo_id: null, description: null,
    industry: "saas", industries_json: null, size_band: "201-500", employees: 320, founded_year: null,
    hq_country_iso2: "US", hq_region: null, hq_city: null, timezone: null, funding_stage: "series_b",
    total_funding_usd: null, last_round_usd: null, last_round_at: null, revenue_band: null,
    linkedin_url: null, crunchbase_url: null, twitter_handle: null, github_org: null,
    status: "active", owner_email: null, fit_score: 0, intent_score: 0, account_score: 0,
    fit_breakdown_json: null, intent_breakdown_json: null, score_recomputed_at: null,
    embedding_dim: null, embedded_at: null, source_url: null, imported_from: null, meta_json: null,
    last_enriched_at: null, created_at: "", updated_at: "",
  };
  const buyers: BuyerRow[] = [{
    id: "b", account_id: "x", name: "Jane", email: null, title: "CTO", role_slug: "cto",
    seniority: "c_suite", department: "engineering", linkedin_url: null, twitter_url: null, phone: null,
    is_decision_maker: 1, is_champion: 0, influence_score: 80, last_seen_at: null, meta_json: null,
    created_at: "", updated_at: "",
  }];
  const tax = new Map<string, RoleTaxonomyRow>();
  const r = computeFit(a, buyers, tax);
  return r.fit_score > 60;
}
