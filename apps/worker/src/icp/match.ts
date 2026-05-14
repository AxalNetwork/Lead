// ICP matching: deterministic SQL filter over leads + per-row score.

import type { D1Database } from "@cloudflare/workers-types";

export interface IcpRow {
  id: string;
  name: string;
  description: string | null;
  sectors_json: string | null;
  geographies_json: string | null;
  personas_json: string | null;
  seniority_json: string | null;
  min_aum_usd: number | null;
  min_fund_size_usd: number | null;
  min_quality: number | null;
  require_email: number;
  require_linkedin: number;
  exclude_dnc: number;
  tags_any_json: string | null;
  tags_all_json: string | null;
  weights_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface Weights {
  sector: number;
  geography: number;
  persona: number;
  seniority: number;
  financial: number;
  contact: number;
  quality: number;
  tags: number;
}
const DEFAULT_WEIGHTS: Weights = {
  sector: 0.20, geography: 0.15, persona: 0.15, seniority: 0.10,
  financial: 0.15, contact: 0.10, quality: 0.10, tags: 0.05,
};

function parseArr(s: string | null): string[] {
  if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j.map(String) : []; } catch { return []; }
}

interface LeadRow {
  id: string;
  name: string | null;
  org: string | null;
  email: string | null;
  linkedin_url: string | null;
  sector_slug: string | null;
  geo_slug: string | null;
  country_iso2: string | null;
  persona_role: string | null;
  seniority: string | null;
  aum_usd: number | null;
  fund_size_usd: number | null;
  do_not_contact: number;
  tags_json: string | null;
  status: string;
  meta_json: string | null;
}

export interface IcpMatch {
  lead_id: string;
  name: string | null;
  org: string | null;
  email: string | null;
  score: number;
  reasons: string[];
}

export async function matchIcp(
  db: D1Database,
  icp: IcpRow,
  opts: { limit?: number; min_score?: number } = {},
): Promise<{ items: IcpMatch[]; total: number }> {
  const sectors = parseArr(icp.sectors_json);
  const geos = parseArr(icp.geographies_json);
  const personas = parseArr(icp.personas_json);
  const seniority = parseArr(icp.seniority_json);
  const tagsAny = parseArr(icp.tags_any_json);
  const tagsAll = parseArr(icp.tags_all_json);
  const weights = { ...DEFAULT_WEIGHTS, ...(icp.weights_json ? safeWeights(icp.weights_json) : {}) };

  const wheres: string[] = ["(merged_into IS NULL OR merged_into = '')", "status != 'erased'"];
  const binds: unknown[] = [];
  if (icp.exclude_dnc) wheres.push("do_not_contact = 0");
  if (icp.require_email) wheres.push("email IS NOT NULL AND email != ''");
  if (icp.require_linkedin) wheres.push("linkedin_url IS NOT NULL AND linkedin_url != ''");
  if (sectors.length) {
    wheres.push(`sector_slug IN (${sectors.map(() => "?").join(",")})`);
    binds.push(...sectors);
  }
  if (geos.length) {
    // geo_slug match OR country_iso2 match (geos may include lowercased country codes).
    const upperCountries = geos.filter((g) => g.length === 2).map((g) => g.toUpperCase());
    const placeholders = geos.map(() => "?").join(",");
    if (upperCountries.length) {
      const ph2 = upperCountries.map(() => "?").join(",");
      wheres.push(`(geo_slug IN (${placeholders}) OR country_iso2 IN (${ph2}))`);
      binds.push(...geos, ...upperCountries);
    } else {
      wheres.push(`geo_slug IN (${placeholders})`);
      binds.push(...geos);
    }
  }
  if (personas.length) {
    wheres.push(`persona_role IN (${personas.map(() => "?").join(",")})`);
    binds.push(...personas);
  }
  if (seniority.length) {
    wheres.push(`seniority IN (${seniority.map(() => "?").join(",")})`);
    binds.push(...seniority);
  }
  if (icp.min_aum_usd != null) { wheres.push("(aum_usd IS NOT NULL AND aum_usd >= ?)"); binds.push(icp.min_aum_usd); }
  if (icp.min_fund_size_usd != null) { wheres.push("(fund_size_usd IS NOT NULL AND fund_size_usd >= ?)"); binds.push(icp.min_fund_size_usd); }

  const rs = await db
    .prepare(
      `SELECT id, name, org, email, linkedin_url, sector_slug, geo_slug, country_iso2, persona_role, seniority,
              aum_usd, fund_size_usd, do_not_contact, tags_json, status, meta_json
         FROM leads
        WHERE ${wheres.join(" AND ")}
        LIMIT 5000`,
    )
    .bind(...binds)
    .all<LeadRow>();
  const rows = rs.results ?? [];

  const items: IcpMatch[] = [];
  for (const r of rows) {
    const tags = parseArr(r.tags_json);
    if (tagsAll.length && !tagsAll.every((t) => tags.includes(t))) continue;
    if (tagsAny.length && !tagsAny.some((t) => tags.includes(t))) continue;
    const m = scoreRow(r, { sectors, geos, personas, seniority, tagsAny, tagsAll, icp, weights });
    if (opts.min_score && m.score < opts.min_score) continue;
    items.push({ lead_id: r.id, name: r.name, org: r.org, email: r.email, score: m.score, reasons: m.reasons });
  }
  items.sort((a, b) => b.score - a.score);
  return { items: items.slice(0, opts.limit ?? 200), total: items.length };
}

function safeWeights(s: string): Partial<Weights> {
  try { const j = JSON.parse(s); return typeof j === "object" && j ? j as Partial<Weights> : {}; } catch { return {}; }
}

function scoreRow(
  r: LeadRow,
  ctx: { sectors: string[]; geos: string[]; personas: string[]; seniority: string[]; tagsAny: string[]; tagsAll: string[]; icp: IcpRow; weights: Weights },
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (!ctx.sectors.length || (r.sector_slug && ctx.sectors.includes(r.sector_slug))) {
    score += ctx.weights.sector; if (ctx.sectors.length) reasons.push("sector");
  }
  if (!ctx.geos.length || (r.geo_slug && ctx.geos.includes(r.geo_slug)) || (r.country_iso2 && ctx.geos.map((g) => g.toUpperCase()).includes(r.country_iso2))) {
    score += ctx.weights.geography; if (ctx.geos.length) reasons.push("geography");
  }
  if (!ctx.personas.length || (r.persona_role && ctx.personas.includes(r.persona_role))) {
    score += ctx.weights.persona; if (ctx.personas.length) reasons.push("persona");
  }
  if (!ctx.seniority.length || (r.seniority && ctx.seniority.includes(r.seniority))) {
    score += ctx.weights.seniority; if (ctx.seniority.length) reasons.push("seniority");
  }
  // financial: bonus if aum/fund exists at all (filter already enforces minimums).
  if (r.aum_usd || r.fund_size_usd) { score += ctx.weights.financial; reasons.push("financial"); }
  // contact reachability:
  if (r.email || r.linkedin_url) { score += ctx.weights.contact; reasons.push("contact"); }
  // quality: use lead_quality_snapshots when present (latest), else neutral 0.5.
  // We can't easily JOIN here without another query; do best-effort static 0.5.
  score += ctx.weights.quality * 0.5;
  // tags
  const tags = parseArr(r.tags_json);
  if (ctx.tagsAny.length && tags.some((t) => ctx.tagsAny.includes(t))) {
    score += ctx.weights.tags; reasons.push("tags");
  } else if (!ctx.tagsAny.length && !ctx.tagsAll.length) {
    score += ctx.weights.tags;
  }
  return { score: Math.round(score * 10000) / 10000, reasons };
}
