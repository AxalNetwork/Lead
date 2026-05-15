// Auto column-mapping from spreadsheet/PDF headers to firms/leads schema.
// Works in two passes: (1) regex-based COLUMN_ALIASES for canonical headers,
// (2) Levenshtein-distance fallback against a known field-name catalog for
// fuzzy header text ("frim name" -> "name", "lnkdin" -> "linkedin_url").

export type Entity = "firms" | "leads";
export interface MappedField { entity: Entity; field: string }

// Canonical entity.field tokens. The same field name may be valid for both
// entities (e.g. "name") — the entity context is decided per-row at import.
const COLUMN_ALIASES: Array<{ field: MappedField; patterns: RegExp[] }> = [
  // Firm core
  { field: { entity: "firms", field: "name" }, patterns: [/^(firm|fund|investor|gp|company|organization|name)\b/i] },
  { field: { entity: "firms", field: "legal_name" }, patterns: [/^(legal\s*name|legal\s*entity|registered\s*name)/i] },
  { field: { entity: "firms", field: "website" }, patterns: [/^(website|url|site|homepage|web\s*site|link|firm\s*url)$/i] },
  { field: { entity: "firms", field: "domain" }, patterns: [/^(domain|hostname)$/i] },
  { field: { entity: "firms", field: "kind" }, patterns: [/^(type|kind|investor\s*type|firm\s*type|category)$/i] },
  { field: { entity: "firms", field: "thesis" }, patterns: [/^(thesis|investment\s*thesis|focus|description|about|summary|notes?)$/i] },
  { field: { entity: "firms", field: "stages" }, patterns: [/^(stage|stages|round|rounds|investment\s*stage)$/i] },
  { field: { entity: "firms", field: "sectors" }, patterns: [/^(sector|sectors|industry|industries|vertical|verticals|focus\s*area)$/i] },
  { field: { entity: "firms", field: "geo_focus" }, patterns: [/^(geo|geography|geographies|region|regions|markets?)$/i] },
  { field: { entity: "firms", field: "hq_city" }, patterns: [/^(city|hq\s*city|town|location|hq|headquarters)$/i] },
  { field: { entity: "firms", field: "hq_region" }, patterns: [/^(state|province|hq\s*region)$/i] },
  { field: { entity: "firms", field: "hq_country_iso2" }, patterns: [/^(country|hq\s*country|nation)$/i] },
  { field: { entity: "firms", field: "check_size_typical_usd" }, patterns: [/^(check|ticket|check\s*size|ticket\s*size|investment\s*size|typical\s*check)$/i] },
  { field: { entity: "firms", field: "check_size_min_usd" }, patterns: [/(check|ticket|investment).*\bmin/i, /^min[_ ]?(check|ticket|investment)/i] },
  { field: { entity: "firms", field: "check_size_max_usd" }, patterns: [/(check|ticket|investment).*\bmax/i, /^max[_ ]?(check|ticket|investment)/i] },
  { field: { entity: "firms", field: "aum_usd" }, patterns: [/^(aum|assets\s*under\s*management)$/i] },
  { field: { entity: "firms", field: "current_fund_size_usd" }, patterns: [/^(fund\s*size|current\s*fund\s*size)$/i] },
  { field: { entity: "firms", field: "current_fund_name" }, patterns: [/^(fund\s*name|current\s*fund)$/i] },
  { field: { entity: "firms", field: "fund_count" }, patterns: [/^(fund\s*count|#\s*funds|number\s*of\s*funds)$/i] },
  { field: { entity: "firms", field: "portfolio_count" }, patterns: [/^(portfolio\s*count|#\s*portfolio|portfolio\s*companies?)$/i] },
  { field: { entity: "firms", field: "notable_investments" }, patterns: [/^(portfolio|investments?|notable\s*investments?|companies?)$/i] },
  { field: { entity: "firms", field: "founded_year" }, patterns: [/^(founded|year\s*founded|established)$/i] },
  { field: { entity: "firms", field: "team_size" }, patterns: [/^(team\s*size|partners?|#\s*partners|headcount|employees)$/i] },
  { field: { entity: "firms", field: "linkedin_url" }, patterns: [/^(linkedin|li\s*url|firm\s*linkedin)$/i] },
  { field: { entity: "firms", field: "crunchbase_url" }, patterns: [/^(crunchbase|cb\s*url)$/i] },
  { field: { entity: "firms", field: "twitter_handle" }, patterns: [/^(twitter|x\b|handle)$/i] },
  { field: { entity: "firms", field: "signal_nfx_url" }, patterns: [/^(signal\s*nfx|nfx)$/i] },
  { field: { entity: "firms", field: "openvc_url" }, patterns: [/^(openvc)$/i] },
  { field: { entity: "firms", field: "submission_url" }, patterns: [/^(submission|pitch\s*form|apply|apply\s*here|submit)$/i] },
  // Lead core
  { field: { entity: "leads", field: "name" }, patterns: [/^(person\s*name|full\s*name|contact\s*name|first\s*name)/i] },
  { field: { entity: "leads", field: "email" }, patterns: [/^(email|e-?mail|contact\s*email)$/i] },
  { field: { entity: "leads", field: "title" }, patterns: [/^(title|role|position|job\s*title)$/i] },
  { field: { entity: "leads", field: "org" }, patterns: [/^(company|employer|organization|firm)$/i] },
  { field: { entity: "leads", field: "linkedin_url" }, patterns: [/^(linkedin|linkedin\s*url|li\s*profile)$/i] },
  { field: { entity: "leads", field: "twitter_url" }, patterns: [/^(twitter\s*url|x\s*url|twitter\s*profile)$/i] },
  { field: { entity: "leads", field: "phone" }, patterns: [/^(phone|tel|mobile|cell)$/i] },
];

// Catalog used by the Levenshtein fallback. Order matters only for ties.
const FIELD_CATALOG: Array<{ token: string; field: MappedField }> = [
  { token: "name", field: { entity: "firms", field: "name" } },
  { token: "website", field: { entity: "firms", field: "website" } },
  { token: "domain", field: { entity: "firms", field: "domain" } },
  { token: "stage", field: { entity: "firms", field: "stages" } },
  { token: "sector", field: { entity: "firms", field: "sectors" } },
  { token: "thesis", field: { entity: "firms", field: "thesis" } },
  { token: "city", field: { entity: "firms", field: "hq_city" } },
  { token: "country", field: { entity: "firms", field: "hq_country_iso2" } },
  { token: "check size", field: { entity: "firms", field: "check_size_typical_usd" } },
  { token: "linkedin", field: { entity: "firms", field: "linkedin_url" } },
  { token: "email", field: { entity: "leads", field: "email" } },
  { token: "title", field: { entity: "leads", field: "title" } },
  { token: "phone", field: { entity: "leads", field: "phone" } },
];

export function autoMapHeader(rawHeader: string): MappedField | null {
  if (!rawHeader) return null;
  const h = rawHeader.trim();
  if (!h) return null;
  for (const m of COLUMN_ALIASES) {
    for (const p of m.patterns) if (p.test(h)) return m.field;
  }
  // Fuzzy fallback. Distance must be <= 2 OR <= 30% of the catalog token.
  const norm = h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  let best: { d: number; field: MappedField } | null = null;
  for (const c of FIELD_CATALOG) {
    const d = levenshtein(norm, c.token);
    const tol = Math.max(2, Math.ceil(c.token.length * 0.3));
    if (d <= tol && (!best || d < best.d)) best = { d, field: c.field };
  }
  return best?.field ?? null;
}

/** Build a header→field map for an array of header strings. */
export function autoMapHeaders(headers: string[]): Record<string, MappedField | null> {
  const out: Record<string, MappedField | null> = {};
  for (const h of headers) out[h] = autoMapHeader(h);
  return out;
}

/** Decide the row-level entity for a file from the dominant mapped entity. */
export function inferEntity(map: Record<string, MappedField | null>): Entity {
  let firms = 0, leads = 0;
  for (const v of Object.values(map)) {
    if (!v) continue;
    if (v.entity === "firms") firms += 1; else leads += 1;
  }
  // Email or LinkedIn-person headers strongly imply leads.
  if (leads > firms) return "leads";
  return "firms";
}

/** Standard two-row DP edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}
