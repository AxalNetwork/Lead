import type { Env } from "../../../types";

/**
 * Lean firm representation produced by every per-source importer.
 * Field names match `firms` columns from migration 090 so the upsert
 * helper can map directly without translation. JSON-array fields
 * (stages_json, sectors_json, geo_focus_json, socials_json,
 * notable_investments_json) are passed as raw arrays here and stringified
 * by the upsert helper before INSERT/UPDATE.
 */
export interface FirmCandidate {
  name: string;
  legal_name?: string | null;
  kind?: string | null; // "vc" | "pe" | "family_office" | "angel" | "syndicate" | "accelerator" | ...
  website?: string | null;
  domain?: string | null;
  logo_url?: string | null;
  hq_country_iso2?: string | null;
  hq_region?: string | null;
  hq_city?: string | null;
  geo_focus?: string[] | null;
  stages?: string[] | null;
  sectors?: string[] | null;
  thesis?: string | null;
  check_size_min_usd?: number | null;
  check_size_max_usd?: number | null;
  check_size_typical_usd?: number | null;
  aum_usd?: number | null;
  fund_count?: number | null;
  current_fund_name?: string | null;
  current_fund_size_usd?: number | null;
  lead_or_co?: string | null;
  portfolio_count?: number | null;
  notable_investments?: string[] | null;
  founded_year?: number | null;
  team_size?: number | null;
  linkedin_url?: string | null;
  crunchbase_url?: string | null;
  twitter_handle?: string | null;
  signal_nfx_url?: string | null;
  openvc_url?: string | null;
  pitchbook_url?: string | null;
  socials?: Record<string, string> | null;
  contact_email?: string | null;
  submission_url?: string | null;
  notes?: string | null;
  source_url?: string | null;
  /**
   * Task #2: tag slugs applied to the unified firm entity post-upsert.
   * Each slug uses the `taxonomy:value` convention consumed by
   * `tagAsFolkImport` in the pipeline:
   *   role:vc_partner | role:accelerator | role:gov_fund | ...
   *   sector:climate | sector:fintech | ...
   *   geo:country:US | geo:geo_metro:new_york | geo:region:europe | ...
   *   stage:seed | stage:series_a | ...
   * Slugs that don't match a known taxonomy prefix are silently dropped.
   * Requires the importer to also set `import_key` so the pipeline can
   * resolve the upserted firm to its unified entity id.
   */
  tags?: string[] | null;
}

/**
 * Person record produced by importers that surface both orgs and people
 * (e.g. Folk shares of angel investors). Mirrors the columns the leads
 * table cares about so the pipeline can route directly to `insertLead`
 * without translation.
 */
export interface PersonCandidate {
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  org?: string | null;
  /** Free-form role tag (e.g. "angel", "vc_partner", "founder", "prospect"). */
  category?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  github_url?: string | null;
  personal_url?: string | null;
  country_iso2?: string | null;
  region?: string | null;
  city?: string | null;
  bio?: string | null;
  /** Geo / sector / stage tag slugs to apply to the unified entity. */
  tags?: string[] | null;
  /** Domain of the page the row was scraped from. */
  source_domain?: string | null;
  /** Original share URL (so re-imports refresh `observed_at`). */
  source_url?: string | null;
}

/**
 * Directed edge between two records emitted by the same importer.
 * The pipeline resolves `from_key` / `to_key` to entity ids using the
 * importer-supplied lookups (e.g. Folk's per-share record id) and writes
 * a `rel_edges` row keyed on (src, dst, kind).
 */
export interface EdgeCandidate {
  /** Stable per-import key (e.g. Folk record id) of the source row. */
  from_key: string;
  /** Stable per-import key of the destination row. */
  to_key: string;
  /** `works_at`, `partner_at`, `invested_in`, etc. */
  kind: string;
}

/**
 * Optional per-record key the importer can attach so the pipeline can
 * resolve `EdgeCandidate.from_key` / `to_key` to the freshly upserted
 * entity ids. Each candidate may carry one if the importer supports it.
 */
export interface KeyedFirmCandidate extends FirmCandidate {
  /** Stable per-import key (e.g. Folk record id). */
  import_key?: string;
}
export interface KeyedPersonCandidate extends PersonCandidate {
  /** Stable per-import key (e.g. Folk record id). */
  import_key?: string;
}

export interface FirmlistImportResult {
  firms: FirmCandidate[];
  /** How many rows the importer saw on the page (pre-dedupe / pre-filter). */
  totalSeen: number;
  /** Soft errors that didn't abort the import. */
  errors?: string[];
  /**
   * Optional: person records produced by importers that surface people
   * (Folk shared lists, Airtable contact views, etc.). Pipeline persists
   * each via the lead-insert path and dual-writes to the unified entity
   * graph. Omitted by org-only importers.
   */
  people?: PersonCandidate[];
  /**
   * Optional: directed edges between extracted rows. Each `from_key` /
   * `to_key` must match the `import_key` field on a returned firm or
   * person; rows without a matching key are silently dropped.
   */
  edges?: EdgeCandidate[];
  /**
   * Task #2: free-text URLs surfaced from "Notes" / "About" / "Thesis"
   * cells in Airtable rows. The pipeline enqueues each as a child
   * `kind='url'` scrape job so a personal-site or Crunchbase link inside
   * a notes cell still gets crawled.
   */
  childUrls?: string[];
  /**
   * Task #2: Airtable Universe explore pages carry a `slug` we encode
   * as `explore.{slug}`. The pipeline writes this as a `collection` tag
   * (taxonomy='tag') on every imported entity so the dashboard can
   * filter "all underrepresented-founder investors", etc.
   */
  sourceCollection?: string | null;
  /**
   * Task #2: per-table metadata for shared-base imports (Airtable
   * Variant B). One entry per table fanned out. The dashboard's
   * mapping UI consumes this to render a tab strip with intent
   * detection (firms / leads / metrics).
   */
  tableTabs?: Array<{ tableId: string; name: string; intent: string; rowCount: number }>;
  /**
   * Task #2: name-only entity stubs derived from Airtable
   * `multipleRecordLinks` columns whose foreign rows lack a URL/domain.
   * The pipeline materializes each stub as a minimal `u_entities` row
   * so edges with these `import_key`s can persist into `rel_edges`
   * instead of being dropped at resolution time.
   */
  stubEntities?: Array<{ import_key: string; kind: "firm" | "person"; name: string }>;
  /**
   * Task #3: firm time-series / KPI / geo facts emitted by importers
   * that surface non-row data (Google Sheets Stats/Monthly/Geos tabs,
   * Airtable metric tables, etc.). `firm_import_key` must match the
   * `import_key` on a returned firm — the pipeline resolves it to a
   * legacy `firms.id` and writes one row per metric into `firm_metrics`
   * (idempotent via the `uq_firm_metrics` unique index).
   */
  metrics?: Array<{
    firm_import_key: string;
    metric_name: string;            // aum_usd|deals_count|exits_count|new_funds|fund_size_usd|geo_pct|stage_pct|sector_pct
    metric_date: string;            // YYYY | YYYY-MM | YYYY-Q# | YYYY-MM-DD | YTD
    dimension?: string | null;      // country iso2, stage, sector — blank for plain time-series
    value_num?: number | null;
    value_text?: string | null;
    source_url?: string | null;
  }>;
  /**
   * Task #3: free-text content from README / Instructions / signup /
   * prose-heavy first tabs that the importer chose not to parse as
   * data. The pipeline persists each entry as a row in
   * `entity_history` (action='import_notes') so the operator can read
   * the original workbook prose from the dashboard.
   */
  importNotes?: Array<{ tab: string; content: string }>;
}

/**
 * Task #2: hints surfaced by the source registry (seed-sources.json or
 * the operator-curated `sources` table). Aggregator importers consume
 * these to tag every emitted firm with the appropriate role / geo /
 * sector slugs. Importers that ignore the third arg keep working
 * unchanged because the parameter is optional.
 *
 * The seed-sources schema uses `role_hint`, `country`, `region`,
 * `geo_metro`, `sector`. The pipeline (`processFirmlist`) maps the seed
 * keys to this normalized shape before invoking the importer.
 */
export interface ImporterHints {
  role?: string | null;
  sector?: string | null;
  geo?: string | null;
  country_iso2?: string | null;
  region?: string | null;
  kind?: string | null;
}

export type FirmlistImporter = (url: string, env: Env, hints?: ImporterHints) => Promise<FirmlistImportResult>;
