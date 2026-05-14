// Wide row type for the leads table after migrations 020/050. Most columns
// are nullable; pipeline code only sets what it has evidence for.

export interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  phone?: string | null;
  org: string | null;
  title: string | null;
  category: string | null;
  source_domain: string | null;
  source_url: string | null;
  status: string;
  verified: number;
  flagged: number;
  approved_at: string | null;
  approved_by: string | null;

  linkedin_url?: string | null;
  twitter_url?: string | null;
  github_url?: string | null;
  personal_url?: string | null;
  alt_emails_json?: string | null;

  persona_role?: string | null;
  seniority?: string | null;
  function_area?: string | null;
  bio?: string | null;

  gender?: string | null;
  age_range?: string | null;
  languages_json?: string | null;

  country_iso2?: string | null;
  region?: string | null;
  city?: string | null;
  timezone?: string | null;

  net_worth_band?: string | null;
  aum_usd?: number | null;
  fund_size_usd?: number | null;
  last_round_usd?: number | null;
  salary_band?: string | null;

  companies_json?: string | null;
  board_seats_json?: string | null;
  awards_json?: string | null;
  exits_json?: string | null;

  priority?: string | null;
  owner_email?: string | null;
  next_action_at?: string | null;
  tags_json?: string | null;
  sector_focus_json?: string | null;

  merged_into?: string | null;
  canonical_email_key?: string | null;
  canonical_phone_key?: string | null;
  canonical_linkedin_key?: string | null;
  canonical_name_firm_key?: string | null;
  canonical_name_city_key?: string | null;
  provider?: string | null;
  provider_score?: number | null;

  last_enriched_at?: string | null;
  locked_fields_json?: string | null;
  enrichment_log_json?: string | null;

  sector_slug?: string | null;
  geo_slug?: string | null;
  do_not_contact?: number;

  meta_json: string | null;
  created_at: string;
  updated_at: string;
}

export type LeadPatch = Partial<Omit<Lead, "id" | "created_at">>;
