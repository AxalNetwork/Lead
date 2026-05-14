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
}

export interface FirmlistImportResult {
  firms: FirmCandidate[];
  /** How many rows the importer saw on the page (pre-dedupe / pre-filter). */
  totalSeen: number;
  /** Soft errors that didn't abort the import. */
  errors?: string[];
}

export type FirmlistImporter = (url: string, env: Env) => Promise<FirmlistImportResult>;
