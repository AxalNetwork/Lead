// Surface entity-store data in the org read paths (firms / companies /
// accounts), mirroring what services/investor_entity_merge.ts already does
// for investors.
//
// WHY THIS EXISTS
// ---------------
// Everything automated writes into the unified entity store (`facts` /
// `entity_summary` / `channels` / `entity_tags`). The AI profile filler in
// particular extracts exactly the fields these pages show blank — thesis,
// contact_email, check sizes, AUM, HQ, founded year, sectors, stages, geo
// focus — and writes them as `facts` rows.
//
// But `routes/firms.ts`, `routes/companies.ts` and `routes/accounts.ts` all
// select the flat legacy columns and nothing else, and `entities/dualwrite.ts`
// only ever copies flat -> facts. So a firm whose thesis was successfully
// extracted still renders "—". This closes that loop on the read side.
//
// The legacy column always wins when populated: it carries manual/import
// authority. The overlay only fills nulls and empty strings.
//
// Everything here is best-effort: a missing table or row yields an empty
// overlay rather than throwing, so fresh installs and test DBs degrade
// quietly instead of 500-ing a detail page.

import type { Env } from "../types";

export type OrgLegacyTable = "firms" | "companies" | "accounts";

/**
 * Keyed by LEGACY COLUMN NAME so application is a plain merge. Array-valued
 * entries correspond to `*_json` columns and are serialised on apply — the
 * dashboard parses those with JSON.parse (see firm-detail.js::fmtArr), so
 * handing it a bare array would silently render "—".
 */
export interface OrgOverlay {
  thesis: string | null;
  description: string | null;
  contact_email: string | null;
  founded_year: number | null;
  hq_city: string | null;
  hq_region: string | null;
  hq_country_iso2: string | null;
  aum_usd: number | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  check_size_typical_usd: number | null;
  website: string | null;
  domain: string | null;
  linkedin_url: string | null;
  twitter_handle: string | null;
  sectors: string[];
  stages: string[];
  geos: string[];
}

const EMPTY: OrgOverlay = {
  thesis: null, description: null, contact_email: null, founded_year: null,
  hq_city: null, hq_region: null, hq_country_iso2: null,
  aum_usd: null, check_size_min_usd: null, check_size_max_usd: null,
  check_size_typical_usd: null,
  website: null, domain: null, linkedin_url: null, twitter_handle: null,
  sectors: [], stages: [], geos: [],
};

function csvToArr(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

interface SummaryRow {
  primary_role: string | null;
  country_iso2: string | null;
  region: string | null;
  city: string | null;
  sectors_csv: string | null;
  stages_csv: string | null;
  geos_csv: string | null;
  check_size_min_usd: number | null;
  check_size_max_usd: number | null;
  primary_email: string | null;
  primary_linkedin: string | null;
  primary_domain: string | null;
}

interface FactRow {
  predicate: string;
  value_text: string | null;
  value_number: number | null;
}

// Predicate names differ between the two writers. entities/dualwrite.ts uses
// the flat column names (city / region / country_iso2); ai/profileFiller.ts
// uses its own extraction-schema names (headquarters_city /
// headquarters_country). Both are read here — see the registry-drift note in
// entities/profile-predicates.ts, which registers neither family.
const FACT_PREDICATES = [
  "thesis", "mission", "description", "bio", "summary",
  "contact_email", "email",
  "founded_year",
  "headquarters_city", "city",
  "headquarters_country", "country_iso2",
  "region",
  "aum_usd",
  "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
  "website", "domain", "linkedin_url", "twitter_handle",
] as const;

/** Resolve a legacy org row to its unified entity and build a scalar overlay. */
export async function loadOrgEntityOverlay(
  env: Env,
  legacyTable: OrgLegacyTable,
  legacyId: string | number,
): Promise<OrgOverlay> {
  try {
    const map = await env.DB
      .prepare("SELECT entity_id FROM entity_legacy_map WHERE legacy_table = ? AND legacy_id = ? LIMIT 1")
      .bind(legacyTable, String(legacyId))
      .first<{ entity_id: string }>()
      .catch(() => null);
    if (!map?.entity_id) return { ...EMPTY };
    const entityId = map.entity_id;

    const overlay: OrgOverlay = { ...EMPTY };

    const summary = await env.DB
      .prepare(
        `SELECT primary_role, country_iso2, region, city, sectors_csv, stages_csv, geos_csv,
                check_size_min_usd, check_size_max_usd, primary_email, primary_linkedin, primary_domain
           FROM entity_summary WHERE entity_id = ?`,
      )
      .bind(entityId)
      .first<SummaryRow>()
      .catch(() => null);
    if (summary) {
      overlay.hq_city = summary.city ?? null;
      overlay.hq_region = summary.region ?? null;
      overlay.hq_country_iso2 = summary.country_iso2 ?? null;
      overlay.sectors = csvToArr(summary.sectors_csv);
      overlay.stages = csvToArr(summary.stages_csv);
      overlay.geos = csvToArr(summary.geos_csv);
      overlay.check_size_min_usd = summary.check_size_min_usd ?? null;
      overlay.check_size_max_usd = summary.check_size_max_usd ?? null;
      overlay.contact_email = summary.primary_email ?? null;
      overlay.linkedin_url = summary.primary_linkedin ?? null;
      overlay.domain = summary.primary_domain ?? null;
    }

    const placeholders = FACT_PREDICATES.map(() => "?").join(",");
    const facts = await env.DB
      .prepare(
        `SELECT predicate, value_text, value_number
           FROM facts
          WHERE entity_id = ? AND is_current = 1 AND predicate IN (${placeholders})
          ORDER BY confidence DESC, observed_at DESC`,
      )
      .bind(entityId, ...FACT_PREDICATES)
      .all<FactRow>()
      .catch(() => ({ results: [] as FactRow[] }));

    // First non-empty wins within each concept — the ORDER BY puts the
    // highest-confidence, most recently observed fact first.
    const takeStr = (cur: string | null, v: string | null) =>
      cur != null && cur !== "" ? cur : (v && v.trim() ? v.trim() : cur);
    const takeNum = (cur: number | null, v: number | null) => (cur != null ? cur : v);

    for (const f of facts.results ?? []) {
      switch (f.predicate) {
        case "thesis": overlay.thesis = takeStr(overlay.thesis, f.value_text); break;
        case "mission":
        case "description":
        case "bio":
        case "summary": overlay.description = takeStr(overlay.description, f.value_text); break;
        case "contact_email":
        case "email": overlay.contact_email = takeStr(overlay.contact_email, f.value_text); break;
        case "founded_year": overlay.founded_year = takeNum(overlay.founded_year, f.value_number); break;
        case "headquarters_city":
        case "city": overlay.hq_city = takeStr(overlay.hq_city, f.value_text); break;
        case "headquarters_country":
        case "country_iso2": overlay.hq_country_iso2 = takeStr(overlay.hq_country_iso2, f.value_text); break;
        case "region": overlay.hq_region = takeStr(overlay.hq_region, f.value_text); break;
        case "aum_usd": overlay.aum_usd = takeNum(overlay.aum_usd, f.value_number); break;
        case "check_size_min_usd": overlay.check_size_min_usd = takeNum(overlay.check_size_min_usd, f.value_number); break;
        case "check_size_max_usd": overlay.check_size_max_usd = takeNum(overlay.check_size_max_usd, f.value_number); break;
        case "check_size_typical_usd": overlay.check_size_typical_usd = takeNum(overlay.check_size_typical_usd, f.value_number); break;
        case "website": overlay.website = takeStr(overlay.website, f.value_text); break;
        case "domain": overlay.domain = takeStr(overlay.domain, f.value_text); break;
        case "linkedin_url": overlay.linkedin_url = takeStr(overlay.linkedin_url, f.value_text); break;
        case "twitter_handle": overlay.twitter_handle = takeStr(overlay.twitter_handle, f.value_text); break;
        default: break;
      }
    }

    // Taxonomy tags are the canonical home for sector/stage/geo focus
    // (entity_summary's CSVs are materialized from them, so this only
    // matters when the summary has not been rebuilt yet).
    if (!overlay.sectors.length || !overlay.stages.length || !overlay.geos.length) {
      const tags = await env.DB
        .prepare(
          `SELECT taxonomy, slug FROM entity_tags
            WHERE entity_id = ? AND taxonomy IN ('sector','stage','geo')
            ORDER BY weight DESC`,
        )
        .bind(entityId)
        .all<{ taxonomy: string; slug: string }>()
        .catch(() => ({ results: [] as Array<{ taxonomy: string; slug: string }> }));
      for (const t of tags.results ?? []) {
        if (t.taxonomy === "sector" && !overlay.sectors.length) overlay.sectors.push(t.slug);
        else if (t.taxonomy === "stage" && !overlay.stages.length) overlay.stages.push(t.slug);
        else if (t.taxonomy === "geo" && !overlay.geos.length) overlay.geos.push(t.slug);
      }
    }

    const chans = await env.DB
      .prepare(
        `SELECT kind, canonical FROM channels
          WHERE entity_id = ? AND kind IN ('website','linkedin','twitter','email')
          ORDER BY is_primary DESC`,
      )
      .bind(entityId)
      .all<{ kind: string; canonical: string }>()
      .catch(() => ({ results: [] as Array<{ kind: string; canonical: string }> }));
    for (const ch of chans.results ?? []) {
      if (ch.kind === "website" && !overlay.website) overlay.website = ch.canonical;
      else if (ch.kind === "linkedin" && !overlay.linkedin_url) overlay.linkedin_url = ch.canonical;
      else if (ch.kind === "twitter" && !overlay.twitter_handle) overlay.twitter_handle = ch.canonical.replace(/^@/, "");
      else if (ch.kind === "email" && !overlay.contact_email) overlay.contact_email = ch.canonical;
    }

    return overlay;
  } catch {
    return { ...EMPTY };
  }
}

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/**
 * Fill blank columns on a legacy row from the overlay, in place on a copy.
 *
 * Only keys already present on `row` are touched, so this is safe across the
 * three tables despite their differing schemas — `thesis` fills on firms and
 * is ignored on accounts, and so on.
 *
 * `*_json` columns receive a JSON **string**, matching how the dashboard
 * parses them.
 */
export function applyOrgOverlay<T extends Record<string, unknown>>(
  row: T,
  overlay: OrgOverlay,
): T & { entity_overlay_applied?: string[] } {
  const out: Record<string, unknown> = { ...row };
  const applied: string[] = [];

  const scalar: Array<[keyof OrgOverlay, string]> = [
    ["thesis", "thesis"],
    ["description", "description"],
    ["contact_email", "contact_email"],
    ["founded_year", "founded_year"],
    ["hq_city", "hq_city"],
    ["hq_region", "hq_region"],
    ["hq_country_iso2", "hq_country_iso2"],
    ["aum_usd", "aum_usd"],
    ["check_size_min_usd", "check_size_min_usd"],
    ["check_size_max_usd", "check_size_max_usd"],
    ["check_size_typical_usd", "check_size_typical_usd"],
    ["website", "website"],
    ["domain", "domain"],
    ["linkedin_url", "linkedin_url"],
    ["twitter_handle", "twitter_handle"],
  ];
  for (const [key, col] of scalar) {
    if (!(col in out)) continue;
    const v = overlay[key];
    if (isBlank(out[col]) && !isBlank(v)) {
      out[col] = v;
      applied.push(col);
    }
  }

  const arrays: Array<[keyof OrgOverlay, string[]]> = [
    ["sectors", ["sectors_json", "industries_json"]],
    ["stages", ["stages_json"]],
    ["geos", ["geo_focus_json"]],
  ];
  for (const [key, cols] of arrays) {
    const vals = overlay[key] as string[];
    if (!vals.length) continue;
    for (const col of cols) {
      if (!(col in out)) continue;
      // Blank means null, "", "[]" or a string that will not parse to a
      // non-empty array — all of which render as "—" today.
      let existingEmpty = true;
      const cur = out[col];
      if (typeof cur === "string" && cur.trim()) {
        try {
          const parsed: unknown = JSON.parse(cur);
          existingEmpty = !Array.isArray(parsed) || parsed.length === 0;
        } catch { existingEmpty = true; }
      }
      if (existingEmpty) {
        out[col] = JSON.stringify(vals);
        applied.push(col);
      }
    }
  }

  if (applied.length) out.entity_overlay_applied = applied;
  return out as T & { entity_overlay_applied?: string[] };
}
