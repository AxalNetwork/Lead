import { countryNameToIso2, extractDomain } from "../../normalize";

/**
 * Heuristic mapping from any spreadsheet/list header text to the canonical
 * `FirmCandidate` field name. Returns null when there's no confident match.
 */
const HEADER_MAP: Array<{ field: string; patterns: RegExp[] }> = [
  { field: "name", patterns: [/^(firm|fund|investor|gp|company|name|organization)\b/i] },
  { field: "legal_name", patterns: [/^(legal\s*name|legal\s*entity|registered\s*name)/i] },
  { field: "website", patterns: [/^(website|url|site|homepage|web\s*site|link)/i] },
  { field: "domain", patterns: [/^(domain|hostname)$/i] },
  { field: "kind", patterns: [/^(type|kind|investor\s*type|firm\s*type|category)$/i] },
  { field: "thesis", patterns: [/^(thesis|investment\s*thesis|focus|description|about|summary|notes?)$/i] },
  { field: "stages", patterns: [/^(stage|stages|round|rounds|investment\s*stage)$/i] },
  { field: "sectors", patterns: [/^(sector|sectors|industry|industries|vertical|verticals|focus\s*area)$/i] },
  { field: "geo_focus", patterns: [/^(geo|geography|geographies|region|regions|markets?)$/i] },
  { field: "hq_city", patterns: [/^(city|hq\s*city|town|location|hq|headquarters)$/i] },
  { field: "hq_region", patterns: [/^(state|province|region|hq\s*region)$/i] },
  { field: "hq_country_iso2", patterns: [/^(country|hq\s*country|nation)$/i] },
  { field: "check_size_typical_usd", patterns: [/^(check|ticket|check\s*size|ticket\s*size|investment\s*size|typical\s*check)$/i] },
  { field: "check_size_min_usd", patterns: [/(check|ticket|investment).*\bmin/i, /^min[_ ]?(check|ticket|investment)/i] },
  { field: "check_size_max_usd", patterns: [/(check|ticket|investment).*\bmax/i, /^max[_ ]?(check|ticket|investment)/i] },
  { field: "aum_usd", patterns: [/^(aum|assets\s*under\s*management)$/i] },
  { field: "fund_count", patterns: [/^(fund\s*count|#\s*funds|number\s*of\s*funds)$/i] },
  { field: "current_fund_size_usd", patterns: [/^(fund\s*size|current\s*fund\s*size|fund)$/i] },
  { field: "current_fund_name", patterns: [/^(fund\s*name|current\s*fund)$/i] },
  { field: "portfolio_count", patterns: [/^(portfolio\s*count|#\s*portfolio|portfolio\s*companies?)$/i] },
  { field: "notable_investments", patterns: [/^(portfolio|investments?|notable\s*investments?|companies?)$/i] },
  { field: "founded_year", patterns: [/^(founded|year\s*founded|established)$/i] },
  { field: "team_size", patterns: [/^(team\s*size|partners?|#\s*partners|headcount|employees)$/i] },
  { field: "linkedin_url", patterns: [/^(linkedin|li\s*url)$/i] },
  { field: "crunchbase_url", patterns: [/^(crunchbase|cb\s*url)$/i] },
  { field: "twitter_handle", patterns: [/^(twitter|x\b|handle)$/i] },
  { field: "signal_nfx_url", patterns: [/^(signal\s*nfx|nfx)$/i] },
  { field: "openvc_url", patterns: [/^(openvc)$/i] },
  { field: "contact_email", patterns: [/^(email|contact|contact\s*email)$/i] },
  { field: "submission_url", patterns: [/^(submission|pitch\s*form|apply|apply\s*here|submit)$/i] },
];

export function mapHeaderToField(rawHeader: string): string | null {
  if (!rawHeader) return null;
  const h = String(rawHeader).trim();
  if (!h) return null;
  for (const m of HEADER_MAP) {
    for (const p of m.patterns) {
      if (p.test(h)) return m.field;
    }
  }
  return null;
}

/** Parse a check / fund-size string like "$500K", "1.5M", "$2-10M", "USD 5,000,000" → number of USD. */
export function parseUsdAmount(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  // Pull the first numeric token (with optional decimal and K/M/B/T suffix).
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(k|m|mn|mm|bn|b|t)?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const suf = m[2] ?? "";
  let mult = 1;
  if (suf === "k") mult = 1_000;
  else if (suf === "m" || suf === "mn" || suf === "mm") mult = 1_000_000;
  else if (suf === "b" || suf === "bn") mult = 1_000_000_000;
  else if (suf === "t") mult = 1_000_000_000_000;
  return Math.trunc(n * mult);
}

/** Parse a min-max range like "$500K–$2M", "1-5M", "100k to 1m". */
export function parseUsdRange(input: string | null | undefined): { min: number | null; max: number | null; typical: number | null } {
  if (!input) return { min: null, max: null, typical: null };
  const s = String(input).replace(/[–—]/g, "-");
  const parts = s.split(/\s*(?:-|to|–|—)\s*/i);
  if (parts.length >= 2) {
    const min = parseUsdAmount(parts[0]);
    const max = parseUsdAmount(parts[1]);
    const typical = min != null && max != null ? Math.trunc((min + max) / 2) : (min ?? max ?? null);
    return { min, max, typical };
  }
  const single = parseUsdAmount(s);
  return { min: single, max: single, typical: single };
}

const STAGE_ALIASES: Record<string, string> = {
  "pre-seed": "pre_seed",
  "preseed": "pre_seed",
  "seed": "seed",
  "series a": "series_a",
  "series-a": "series_a",
  "a": "series_a",
  "series b": "series_b",
  "b": "series_b",
  "series c": "series_c",
  "c": "series_c",
  "series d": "series_d",
  "d": "series_d",
  "growth": "growth",
  "late stage": "late_stage",
  "late-stage": "late_stage",
  "late": "late_stage",
};

export function parseStages(input: string | string[] | null | undefined): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[,;/|]+/);
  const out = new Set<string>();
  for (const raw of arr) {
    const k = String(raw).trim().toLowerCase();
    if (!k) continue;
    out.add(STAGE_ALIASES[k] ?? k.replace(/\s+/g, "_"));
  }
  return [...out];
}

export function parseList(input: string | string[] | null | undefined): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input).split(/[,;/|]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse a location string like "New York, NY" or "London, UK" into city /
 * region / country_iso2. Best-effort; missing pieces stay null.
 */
export function parseLocation(input: string | null | undefined): { city: string | null; region: string | null; country_iso2: string | null } {
  if (!input) return { city: null, region: null, country_iso2: null };
  const parts = String(input).split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { city: null, region: null, country_iso2: null };
  if (parts.length === 1) {
    // Could be "USA" alone or just a city.
    const iso = countryNameToIso2(parts[0]);
    if (iso) return { city: null, region: null, country_iso2: iso };
    return { city: parts[0], region: null, country_iso2: null };
  }
  // Try to interpret last token as country.
  const lastIso = countryNameToIso2(parts[parts.length - 1]);
  if (lastIso) {
    return {
      city: parts[0],
      region: parts.length >= 3 ? parts[1] : null,
      country_iso2: lastIso,
    };
  }
  // Fallback: treat second token as region (US-style "City, ST").
  const region = parts[1];
  return {
    city: parts[0],
    region,
    country_iso2: region.length === 2 ? "US" : null,
  };
}

/** Derive a domain from a website URL or freeform string ("example.com"). */
export function deriveDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return extractDomain(s) || null;
  // Bare hostname / "example.com" / "@example.com"
  const cleaned = s.replace(/^@/, "").replace(/^www\./i, "").split("/")[0];
  return cleaned.toLowerCase().includes(".") ? cleaned.toLowerCase() : null;
}

export function ensureWebsite(domain: string | null, website: string | null): string | null {
  if (website) return website;
  if (domain) return `https://${domain}`;
  return null;
}

/**
 * Build a FirmCandidate from a header→value object using the auto-mapped
 * fields. Unknown headers are preserved into `notes` as "header: value" lines
 * so no information is lost.
 */
export function rowToCandidate(row: Record<string, unknown>, sourceUrl: string): FirmCandidateBuilderResult | null {
  const out: Record<string, unknown> = {};
  const unmapped: string[] = [];
  for (const [rawHeader, rawValue] of Object.entries(row)) {
    if (rawValue == null || rawValue === "") continue;
    const field = mapHeaderToField(rawHeader);
    if (!field) {
      unmapped.push(`${rawHeader}: ${String(rawValue)}`);
      continue;
    }
    const v = rawValue;
    switch (field) {
      case "stages":
      case "sectors":
      case "geo_focus":
      case "notable_investments":
        out[field] = parseList(v as string | string[]);
        break;
      case "check_size_min_usd":
        out.check_size_min_usd = parseUsdAmount(v as string);
        break;
      case "check_size_max_usd":
        out.check_size_max_usd = parseUsdAmount(v as string);
        break;
      case "check_size_typical_usd": {
        const range = parseUsdRange(String(v));
        if (range.min != null) out.check_size_min_usd = range.min;
        if (range.max != null) out.check_size_max_usd = range.max;
        out.check_size_typical_usd = range.typical;
        break;
      }
      case "aum_usd":
      case "current_fund_size_usd":
        out[field] = parseUsdAmount(v as string);
        break;
      case "fund_count":
      case "portfolio_count":
      case "founded_year":
      case "team_size": {
        const n = Number(String(v).replace(/[^\d.-]/g, ""));
        if (Number.isFinite(n)) out[field] = Math.trunc(n);
        break;
      }
      case "hq_country_iso2": {
        const iso = countryNameToIso2(String(v));
        if (iso) out.hq_country_iso2 = iso;
        else if (String(v).length === 2) out.hq_country_iso2 = String(v).toUpperCase();
        break;
      }
      case "hq_city": {
        // City fields commonly carry full "City, ST, Country" strings.
        const loc = parseLocation(String(v));
        if (loc.city) out.hq_city = loc.city;
        if (loc.region && !out.hq_region) out.hq_region = loc.region;
        if (loc.country_iso2 && !out.hq_country_iso2) out.hq_country_iso2 = loc.country_iso2;
        break;
      }
      case "domain": {
        const d = deriveDomain(String(v));
        if (d) out.domain = d;
        break;
      }
      case "website": {
        const s = String(v).trim();
        out.website = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/\//, "")}`;
        if (!out.domain) {
          const d = deriveDomain(out.website as string);
          if (d) out.domain = d;
        }
        break;
      }
      case "twitter_handle": {
        const handle = String(v).trim().replace(/^@/, "").replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, "");
        if (handle) out.twitter_handle = handle.split(/[/?#]/)[0];
        break;
      }
      default:
        out[field] = typeof v === "string" ? v.trim() : v;
    }
  }
  const name = (out.name as string | undefined)?.trim();
  if (!name) return null;
  if (unmapped.length) out.notes = unmapped.join("\n");
  out.source_url = sourceUrl;
  return { candidate: out as unknown as import("./types").FirmCandidate };
}

interface FirmCandidateBuilderResult {
  candidate: import("./types").FirmCandidate;
}

/** Find every URL-shaped string in a blob of text. */
export function extractAllUrls(text: string): string[] {
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0].replace(/[.,;:]+$/, ""));
  return [...out];
}
