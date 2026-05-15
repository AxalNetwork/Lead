// Shared filter parser for /api/firms, /api/firms/aggregate and the
// /api/analytics/firms/* endpoints. Centralizing it ensures the search
// page, summary strip and chart drilldowns stay in sync.

export interface FirmFilter {
  q?: string;
  kind?: string;
  country?: string;
  city?: string;
  invests_in?: string[];   // geo slugs (substring match in geo_focus_json)
  stages?: string[];       // substring match in stages_json
  sectors?: string[];      // substring match in sectors_json
  check_min?: number;
  check_max?: number;
  aum_min?: number;
  aum_max?: number;
  lead_or_co?: string;     // "lead" | "co" | "both"
  min_portfolio?: number;
  has_unicorns?: boolean;
  has_contact_email?: boolean;
  modified_from?: string;  // ISO date
  modified_to?: string;
}

function intOrUndef(v: string | null | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function multi(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseFirmFilter(qs: URLSearchParams): FirmFilter {
  return {
    q: qs.get("q")?.trim() || undefined,
    kind: qs.get("kind") || undefined,
    country: qs.get("country")?.toUpperCase() || undefined,
    city: qs.get("city")?.trim() || undefined,
    invests_in: multi(qs.get("invests_in")),
    stages: multi(qs.get("stages") ?? qs.get("stage")),
    sectors: multi(qs.get("sectors") ?? qs.get("sector")),
    check_min: intOrUndef(qs.get("check_min")),
    check_max: intOrUndef(qs.get("check_max")),
    aum_min: intOrUndef(qs.get("aum_min")),
    aum_max: intOrUndef(qs.get("aum_max")),
    lead_or_co: qs.get("lead_or_co") || undefined,
    min_portfolio: intOrUndef(qs.get("min_portfolio")),
    has_unicorns: qs.get("has_unicorns") === "1" || qs.get("has_unicorns") === "true" || undefined,
    has_contact_email: qs.get("has_email") === "1" || qs.get("has_email") === "true" || undefined,
    modified_from: qs.get("modified_from") || undefined,
    modified_to: qs.get("modified_to") || undefined,
  };
}

// Build a parameterized WHERE clause + bind list. Returns an empty string
// when nothing is filtered. Stages/sectors/geo_focus are JSON arrays so we
// substring-match the slug between quotes — same convention as the LIST
// route. All numeric/string comparisons are bound; no string interpolation.
export function buildFirmWhere(f: FirmFilter): { sql: string; binds: unknown[] } {
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (f.q) {
    wheres.push("(name LIKE ? OR thesis LIKE ?)");
    binds.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.kind) { wheres.push("kind = ?"); binds.push(f.kind); }
  if (f.country) { wheres.push("hq_country_iso2 = ?"); binds.push(f.country); }
  if (f.city) { wheres.push("hq_city LIKE ?"); binds.push(`%${f.city}%`); }
  if (f.invests_in && f.invests_in.length) {
    for (const g of f.invests_in) {
      wheres.push("geo_focus_json LIKE ?"); binds.push(`%"${g}"%`);
    }
  }
  if (f.stages && f.stages.length) {
    const ors = f.stages.map(() => "stages_json LIKE ?").join(" OR ");
    wheres.push(`(${ors})`);
    for (const s of f.stages) binds.push(`%"${s}"%`);
  }
  if (f.sectors && f.sectors.length) {
    const ors = f.sectors.map(() => "sectors_json LIKE ?").join(" OR ");
    wheres.push(`(${ors})`);
    for (const s of f.sectors) binds.push(`%"${s}"%`);
  }
  if (f.check_min != null) { wheres.push("check_size_typical_usd >= ?"); binds.push(f.check_min); }
  if (f.check_max != null) { wheres.push("check_size_typical_usd <= ?"); binds.push(f.check_max); }
  if (f.aum_min != null) { wheres.push("aum_usd >= ?"); binds.push(f.aum_min); }
  if (f.aum_max != null) { wheres.push("aum_usd <= ?"); binds.push(f.aum_max); }
  if (f.lead_or_co && f.lead_or_co !== "both") {
    wheres.push("lead_or_co = ?"); binds.push(f.lead_or_co);
  }
  if (f.min_portfolio != null) {
    wheres.push("COALESCE(portfolio_count, 0) >= ?"); binds.push(f.min_portfolio);
  }
  if (f.has_unicorns) { wheres.push("COALESCE(unicorns_count, 0) > 0"); }
  if (f.has_contact_email) { wheres.push("contact_email IS NOT NULL AND contact_email != ''"); }
  if (f.modified_from) { wheres.push("last_modified >= ?"); binds.push(f.modified_from); }
  if (f.modified_to) { wheres.push("last_modified <= ?"); binds.push(f.modified_to); }
  const sql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  return { sql, binds };
}
