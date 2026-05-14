-- Task 7: Taxonomies + ICPs.
-- Sectors and geographies provide canonical slugs that the tagging service
-- maps freeform strings to (via aliases_json). ICPs reference sector/geography
-- slugs and persona criteria.

CREATE TABLE IF NOT EXISTS tax_sectors (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_slug TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tax_sectors_parent ON tax_sectors(parent_slug);

CREATE TABLE IF NOT EXISTS tax_geographies (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'country' | 'metro' | 'region'
  country_iso2 TEXT,                 -- always set for kind='country' or 'metro'
  parent_slug TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tax_geo_country ON tax_geographies(country_iso2);
CREATE INDEX IF NOT EXISTS idx_tax_geo_kind ON tax_geographies(kind);

-- ICP profiles: criteria to filter the lead universe to a target list.
-- All filter columns are JSON arrays of slugs/strings; null = no constraint.
CREATE TABLE IF NOT EXISTS icp_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sectors_json TEXT,                 -- ["ai_infrastructure", ...] (slugs)
  geographies_json TEXT,             -- ["us", "fr", "us-sf-bay-area"]
  personas_json TEXT,                -- ["partner", "venture_partner", "gov_official"]
  seniority_json TEXT,               -- ["c_level", "founder", "partner"]
  min_aum_usd REAL,
  min_fund_size_usd REAL,
  min_quality REAL,                  -- 0..1
  require_email INTEGER NOT NULL DEFAULT 0,
  require_linkedin INTEGER NOT NULL DEFAULT 0,
  exclude_dnc INTEGER NOT NULL DEFAULT 1,
  tags_any_json TEXT,                -- match if any tag overlaps
  tags_all_json TEXT,                -- must contain all
  weights_json TEXT,                 -- per-field score weights
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_icp_created ON icp_profiles(created_at);

-- Add taxonomy slug columns to leads (kept alongside sector_focus_json which
-- holds the original freeform values).
ALTER TABLE leads ADD COLUMN sector_slug TEXT;
ALTER TABLE leads ADD COLUMN geo_slug TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_sector_slug ON leads(sector_slug);
CREATE INDEX IF NOT EXISTS idx_leads_geo_slug ON leads(geo_slug);
