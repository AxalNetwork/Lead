// Smart column auto-mapper v2 (Task #2).
//
// Three-tier scoring (highest wins) for each header:
//   1. Exact alias hit  → confidence 1.00
//   2. Regex pattern hit → confidence 0.85 (or per-rule)
//   3. Fuzzy + sample-content heuristic → confidence 0.40..0.75
//
// Returns a confidence score per header so the UI can render bars and
// flag low-confidence mappings for the operator.

export type Entity = "firms" | "leads" | "firm_metrics";
export interface MappedField { entity: Entity; field: string }
export interface MappedFieldWithConfidence extends MappedField { confidence: number }

// ~300-entry alias dictionary. Keys are normalized (lower, ascii, single
// space). Each maps to {entity, field}. This is the fast first-pass lookup;
// patterns below catch the rest.
const ALIAS_DICT: Record<string, MappedField> = (() => {
  const d: Record<string, MappedField> = {};
  // First-write-wins so that the canonical entity (firms, registered first)
  // beats overlapping leads aliases like "company"/"linkedin"/"name".
  const reg = (entity: Entity, field: string, ...aliases: string[]): void => {
    for (const a of aliases) {
      const k = normalize(a);
      if (k && !(k in d)) d[k] = { entity, field };
    }
  };
  // ---- firms.name ----
  reg("firms", "name",
    "name", "firm name", "fund name", "firm", "fund", "investor", "investor name",
    "gp name", "gp", "company", "organization", "organisation", "org",
    "vc", "vc name", "vc firm", "lp name", "fund manager", "manager", "partner firm",
    "investment firm", "investing entity", "entity", "institution");
  // ---- firms.legal_name ----
  reg("firms", "legal_name",
    "legal name", "legal entity", "registered name", "incorporated name", "company name legal",
    "official name", "registration name");
  // ---- firms.website ----
  reg("firms", "website",
    "website", "web site", "url", "site", "homepage", "home page", "link",
    "firm url", "firm website", "company url", "company website", "fund website",
    "official website", "main url", "web address", "web", "site url", "site link");
  // ---- firms.domain ----
  reg("firms", "domain",
    "domain", "hostname", "domain name", "primary domain", "host", "tld");
  // ---- firms.kind ----
  reg("firms", "kind",
    "type", "kind", "investor type", "firm type", "category", "fund type",
    "entity type", "vehicle type", "structure", "classification", "fund category",
    "investor category", "vc type");
  // ---- firms.thesis ----
  reg("firms", "thesis",
    "thesis", "investment thesis", "focus", "description", "about", "summary",
    "notes", "note", "blurb", "tagline", "mission", "what we do", "investment focus",
    "investment strategy", "strategy", "approach", "philosophy", "overview",
    "about the firm", "fund description", "details", "remarks");
  // ---- firms.stages ----
  reg("firms", "stages",
    "stage", "stages", "round", "rounds", "investment stage", "preferred stage",
    "stage focus", "investing stage", "round stage", "stage of investment",
    "rounds led", "lifecycle", "company stage");
  // ---- firms.sectors ----
  reg("firms", "sectors",
    "sector", "sectors", "industry", "industries", "vertical", "verticals",
    "focus area", "focus areas", "industry focus", "sector focus", "domains",
    "categories", "themes", "investment themes", "investment categories",
    "industry vertical", "domain expertise", "expertise");
  // ---- firms.geo_focus ----
  reg("firms", "geo_focus",
    "geo", "geography", "geographies", "region", "regions", "markets", "market",
    "geo focus", "geographic focus", "geography focus", "investment geography",
    "country focus", "countries", "region focus", "operating region",
    "deployment region", "target geography", "target market", "target markets",
    "geographic exposure", "geos");
  // ---- firms.hq_city ----
  reg("firms", "hq_city",
    "city", "hq city", "town", "location", "hq", "headquarters", "office location",
    "main office", "based in", "based", "head office", "principal office",
    "office", "offices", "primary office");
  // ---- firms.hq_region ----
  reg("firms", "hq_region",
    "state", "province", "hq region", "region (hq)", "us state", "county",
    "prefecture", "department", "oblast", "subnational", "state province");
  // ---- firms.hq_country_iso2 ----
  reg("firms", "hq_country_iso2",
    "country", "hq country", "nation", "country (hq)", "country of registration",
    "incorporation country", "jurisdiction", "country code", "iso country",
    "iso2", "country iso", "domiciled in", "domicile");
  // ---- firms.check_size_typical_usd ----
  reg("firms", "check_size_typical_usd",
    "check", "ticket", "check size", "ticket size", "investment size",
    "typical check", "typical ticket", "average check", "avg check",
    "investment amount", "deal size", "first check", "initial check",
    "writing check", "check writes");
  // ---- firms.check_size_min_usd ----
  reg("firms", "check_size_min_usd",
    "min check", "minimum check", "min ticket", "minimum ticket",
    "min investment", "minimum investment", "check min", "ticket min",
    "lower bound", "from amount", "min size");
  // ---- firms.check_size_max_usd ----
  reg("firms", "check_size_max_usd",
    "max check", "maximum check", "max ticket", "maximum ticket",
    "max investment", "maximum investment", "check max", "ticket max",
    "upper bound", "to amount", "max size", "ceiling");
  // ---- firms.aum_usd (also drives firm_metrics.aum_usd) ----
  reg("firms", "aum_usd",
    "aum", "assets under management", "total aum", "managed assets",
    "total assets", "capital under management", "cum");
  // ---- firms.current_fund_size_usd ----
  reg("firms", "current_fund_size_usd",
    "fund size", "current fund size", "latest fund size", "fund value",
    "vehicle size", "current vehicle size", "fund commitments");
  // ---- firms.current_fund_name ----
  reg("firms", "current_fund_name",
    "fund name", "current fund", "latest fund", "active fund", "vehicle name",
    "current vehicle", "fund (current)");
  // ---- firms.fund_count ----
  reg("firms", "fund_count",
    "fund count", "number of funds", "funds raised", "vintages",
    "total funds", "fund vintages");
  // ---- firms.portfolio_count ----
  reg("firms", "portfolio_count",
    "portfolio count", "portfolio companies", "number of portfolio",
    "investments count", "deal count", "deals", "deals to date",
    "active investments", "total investments");
  // ---- firms.notable_investments ----
  reg("firms", "notable_investments",
    "portfolio", "investments", "notable investments", "companies",
    "key investments", "selected investments", "select portfolio",
    "headline investments", "top investments");
  // ---- firms.founded_year ----
  reg("firms", "founded_year",
    "founded", "year founded", "established", "founding year",
    "inception year", "vintage year", "vintage", "year established",
    "started", "year started");
  // ---- firms.team_size ----
  reg("firms", "team_size",
    "team size", "partners", "no of partners", "headcount", "employees",
    "team", "team count", "investment team", "partner count", "staff",
    "investment professionals", "ip count");
  // ---- firms social URLs ----
  reg("firms", "linkedin_url",
    "linkedin", "li url", "firm linkedin", "linkedin profile",
    "linkedin company page", "linkedin page");
  reg("firms", "crunchbase_url",
    "crunchbase", "cb url", "crunchbase profile", "cb link", "cb",
    "crunchbase link");
  reg("firms", "twitter_handle",
    "twitter", "x", "handle", "twitter handle", "x handle",
    "twitter profile", "twitter url");
  reg("firms", "signal_nfx_url", "signal nfx", "nfx", "nfx signal", "signal");
  reg("firms", "openvc_url", "openvc", "open vc", "open vc profile");
  reg("firms", "submission_url",
    "submission", "pitch form", "apply", "apply here", "submit",
    "submit pitch", "pitch link", "pitch url", "submission form",
    "intake form", "deal submission", "send pitch");
  reg("firms", "contact_email",
    "contact email", "general email", "submission email", "intake email",
    "deals email", "info email");
  // ---- leads ----
  reg("leads", "name",
    "person name", "full name", "contact name", "first name last name",
    "lead name", "individual", "person");
  reg("leads", "email",
    "email", "e mail", "contact email (person)", "personal email",
    "work email", "primary email");
  reg("leads", "title",
    "title", "role", "position", "job title", "designation", "job role",
    "current role", "role title");
  reg("leads", "org",
    "company", "employer", "organization", "organisation", "firm",
    "current company", "company name", "works at", "current employer");
  reg("leads", "linkedin_url", "linkedin", "linkedin url", "li profile", "linkedin profile");
  reg("leads", "twitter_url", "twitter url", "x url", "twitter profile");
  reg("leads", "phone", "phone", "tel", "mobile", "cell", "phone number",
    "telephone", "contact number");
  // ---- firm_metrics (time-series) ----
  reg("firm_metrics", "deals_count",
    "deals count", "deals per year", "deals/year", "deals (yr)",
    "deals this year", "investments per year", "annual deals",
    "yearly deals", "deal flow", "deals done", "deals made", "investments made");
  reg("firm_metrics", "exits_count",
    "exits", "exits count", "exits per year", "exit count",
    "annual exits", "ipo count", "acquisitions count", "m a count");
  reg("firm_metrics", "new_funds",
    "new funds", "funds raised this year", "funds (yr)", "fundraises",
    "funds closed", "funds launched");
  reg("firm_metrics", "fund_size_usd",
    "fund size (yr)", "fund size by year", "vintage size", "raise size",
    "round size", "annual fund size");
  reg("firm_metrics", "geo_pct", "geo %", "geo share", "country %",
    "country share", "region %", "region share", "geo allocation");
  reg("firm_metrics", "stage_pct", "stage %", "stage share", "round %",
    "round share", "stage allocation");
  reg("firm_metrics", "sector_pct", "sector %", "industry %", "vertical %",
    "sector share", "industry share", "sector allocation");
  reg("firm_metrics", "aum_usd", "aum by year", "aum (yr)", "annual aum",
    "year end aum", "aum per year");
  return d;
})();

// Loose regex fallbacks for headers that don't match aliases verbatim.
const PATTERNS: Array<{ field: MappedField; re: RegExp; conf: number }> = [
  { field: { entity: "firms", field: "name" }, re: /^(firm|fund|investor|gp|company|organi[sz]ation|name)\b/i, conf: 0.85 },
  { field: { entity: "firms", field: "website" }, re: /\b(website|web\s*site|url|home\s*page|link|site)\b/i, conf: 0.80 },
  { field: { entity: "firms", field: "thesis" }, re: /\b(thesis|focus|description|about|summary|notes?|blurb)\b/i, conf: 0.70 },
  { field: { entity: "firms", field: "stages" }, re: /\b(stage|round|series|round\s*size)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "sectors" }, re: /\b(sector|industry|vertical|theme|category)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "geo_focus" }, re: /\b(geo|geograph|region|market|country\s*focus)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "hq_city" }, re: /\b(city|town|hq|headquarters|location|based)\b/i, conf: 0.72 },
  { field: { entity: "firms", field: "hq_country_iso2" }, re: /\b(country|nation|jurisdiction|domicile)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "check_size_typical_usd" }, re: /\b(check\s*size|ticket\s*size|typical\s*check|avg\s*check|investment\s*size|deal\s*size)\b/i, conf: 0.85 },
  { field: { entity: "firms", field: "check_size_min_usd" }, re: /\b(min(imum)?\s*(check|ticket|investment)|(check|ticket|investment)\s*min)\b/i, conf: 0.85 },
  { field: { entity: "firms", field: "check_size_max_usd" }, re: /\b(max(imum)?\s*(check|ticket|investment)|(check|ticket|investment)\s*max)\b/i, conf: 0.85 },
  { field: { entity: "firms", field: "aum_usd" }, re: /\b(aum|assets\s*under\s*management)\b/i, conf: 0.90 },
  { field: { entity: "firms", field: "current_fund_size_usd" }, re: /\b(fund\s*size|vehicle\s*size)\b/i, conf: 0.80 },
  { field: { entity: "firms", field: "founded_year" }, re: /\b(founded|inception|vintage|established|year\s*(founded|started))\b/i, conf: 0.88 },
  { field: { entity: "firms", field: "team_size" }, re: /\b(team\s*size|head\s*count|employees|partner\s*count|investment\s*team)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "linkedin_url" }, re: /\blinkedin\b/i, conf: 0.92 },
  { field: { entity: "firms", field: "crunchbase_url" }, re: /\b(crunchbase|cb\b)\b/i, conf: 0.92 },
  { field: { entity: "firms", field: "twitter_handle" }, re: /\b(twitter|x\s*handle|@?handle)\b/i, conf: 0.78 },
  { field: { entity: "firms", field: "submission_url" }, re: /\b(submission|pitch\s*form|apply|intake)\b/i, conf: 0.85 },
  { field: { entity: "leads", field: "email" }, re: /\bemail\b/i, conf: 0.95 },
  { field: { entity: "leads", field: "phone" }, re: /\b(phone|tel|mobile|cell)\b/i, conf: 0.92 },
  { field: { entity: "leads", field: "title" }, re: /\b(title|role|position|job)\b/i, conf: 0.78 },
];

// Sample-content heuristics. When the header gives us nothing useful, we
// peek at the first ~10 cell values and infer the field from content shape.
interface SampleHeuristic { test: (sample: string[]) => boolean; field: MappedField; conf: number }

const SAMPLE_HEURISTICS: SampleHeuristic[] = [
  { test: (s) => fracMatch(s, /^https?:\/\//i) >= 0.6, field: { entity: "firms", field: "website" }, conf: 0.55 },
  { test: (s) => fracMatch(s, /\blinkedin\.com\b/i) >= 0.5, field: { entity: "firms", field: "linkedin_url" }, conf: 0.85 },
  { test: (s) => fracMatch(s, /\bcrunchbase\.com\b/i) >= 0.5, field: { entity: "firms", field: "crunchbase_url" }, conf: 0.85 },
  { test: (s) => fracMatch(s, /^[^\s@]+@[^\s@]+\.[^\s@]+$/) >= 0.5, field: { entity: "leads", field: "email" }, conf: 0.85 },
  { test: (s) => fracMatch(s, /[\u{1F1E6}-\u{1F1FF}]{2}/u) >= 0.4, field: { entity: "firms", field: "hq_country_iso2" }, conf: 0.75 },
  { test: (s) => fracMatch(s, /^\$|€|£|¥|[\d.,]+\s*(k|m|b|mn|bn)\b/i) >= 0.5, field: { entity: "firms", field: "check_size_typical_usd" }, conf: 0.50 },
  { test: (s) => fracMatch(s, /\b(seed|series\s*[a-f]|pre[\s-]?seed|growth)\b/i) >= 0.4, field: { entity: "firms", field: "stages" }, conf: 0.65 },
  { test: (s) => fracMatch(s, /\b(19|20)\d{2}\b/) >= 0.6, field: { entity: "firms", field: "founded_year" }, conf: 0.45 },
];

function fracMatch(sample: string[], re: RegExp): number {
  if (!sample.length) return 0;
  const hits = sample.filter((v) => v && re.test(v)).length;
  return hits / sample.length;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Map a single header. Returns the best (entity,field,confidence) or null. */
export function autoMapHeader(rawHeader: string, sample: string[] = []): MappedFieldWithConfidence | null {
  if (!rawHeader) return null;
  const norm = normalize(rawHeader);
  if (!norm) return inferFromSample(sample);
  // Tier 1: exact alias.
  const exact = ALIAS_DICT[norm];
  if (exact) return { ...exact, confidence: 1 };
  // Tier 2: regex patterns over the raw header.
  for (const p of PATTERNS) {
    if (p.re.test(rawHeader)) return { ...p.field, confidence: p.conf };
  }
  // Tier 3a: fuzzy (Levenshtein) over the alias dictionary.
  let bestFuzz: { d: number; entry: MappedField } | null = null;
  for (const [k, v] of Object.entries(ALIAS_DICT)) {
    if (Math.abs(k.length - norm.length) > 4) continue; // cheap prune
    const d = levenshtein(norm, k);
    const tol = Math.max(2, Math.ceil(k.length * 0.25));
    if (d <= tol && (!bestFuzz || d < bestFuzz.d)) bestFuzz = { d, entry: v };
  }
  if (bestFuzz) {
    const conf = Math.max(0.4, Math.min(0.75, 0.75 - bestFuzz.d * 0.08));
    return { ...bestFuzz.entry, confidence: conf };
  }
  // Tier 3b: sample heuristics.
  return inferFromSample(sample);
}

function inferFromSample(sample: string[]): MappedFieldWithConfidence | null {
  for (const h of SAMPLE_HEURISTICS) {
    if (h.test(sample)) return { ...h.field, confidence: h.conf };
  }
  return null;
}

/** Map every header, given optional per-header sample values. Returns the
 *  per-header mapping AND the per-header confidence. */
export function autoMapHeaders(
  headers: string[],
  samples: Record<string, string[]> = {},
): { map: Record<string, MappedField | null>; confidence: Record<string, number> } {
  const map: Record<string, MappedField | null> = {};
  const confidence: Record<string, number> = {};
  for (const h of headers) {
    const r = autoMapHeader(h, samples[h] ?? []);
    if (r) {
      map[h] = { entity: r.entity, field: r.field };
      confidence[h] = r.confidence;
    } else {
      map[h] = null;
      confidence[h] = 0;
    }
  }
  return { map, confidence };
}

/** Decide the row-level entity for a single tab from the dominant mapped entity. */
export function inferEntity(map: Record<string, MappedField | null>): Entity {
  let firms = 0, leads = 0, metrics = 0;
  for (const v of Object.values(map)) {
    if (!v) continue;
    if (v.entity === "firms") firms += 1;
    else if (v.entity === "leads") leads += 1;
    else metrics += 1;
  }
  if (leads > firms && leads > metrics) return "leads";
  if (metrics > firms && metrics > leads) return "firm_metrics";
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
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

/** Build a per-header sample of up to N values, skipping blanks. Used by
 *  parse.ts to feed `autoMapHeaders` with content hints. */
export function buildSamples(
  headers: string[],
  rows: Array<Record<string, string>>,
  n = 10,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of headers) {
    const xs: string[] = [];
    for (const r of rows) {
      const v = (r[h] ?? "").trim();
      if (v) xs.push(v);
      if (xs.length >= n) break;
    }
    out[h] = xs;
  }
  return out;
}
