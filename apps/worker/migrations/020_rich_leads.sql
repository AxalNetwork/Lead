-- Task 2: promote useful lead fields out of meta_json into typed columns.
-- meta_json is preserved for raw evidence and parser-specific blobs.

-- Identity / contact
ALTER TABLE leads ADD COLUMN phone TEXT;
ALTER TABLE leads ADD COLUMN linkedin_url TEXT;
ALTER TABLE leads ADD COLUMN twitter_url TEXT;
ALTER TABLE leads ADD COLUMN github_url TEXT;
ALTER TABLE leads ADD COLUMN personal_url TEXT;
ALTER TABLE leads ADD COLUMN alt_emails_json TEXT;

-- Persona
ALTER TABLE leads ADD COLUMN persona_role TEXT;
ALTER TABLE leads ADD COLUMN seniority TEXT;
ALTER TABLE leads ADD COLUMN function_area TEXT;
ALTER TABLE leads ADD COLUMN bio TEXT;

-- Demographics
ALTER TABLE leads ADD COLUMN gender TEXT;
ALTER TABLE leads ADD COLUMN age_range TEXT;
ALTER TABLE leads ADD COLUMN languages_json TEXT;

-- Geography
ALTER TABLE leads ADD COLUMN country_iso2 TEXT;
ALTER TABLE leads ADD COLUMN region TEXT;
ALTER TABLE leads ADD COLUMN city TEXT;
ALTER TABLE leads ADD COLUMN timezone TEXT;

-- Financial signals
ALTER TABLE leads ADD COLUMN net_worth_band TEXT;
ALTER TABLE leads ADD COLUMN aum_usd INTEGER;
ALTER TABLE leads ADD COLUMN fund_size_usd INTEGER;
ALTER TABLE leads ADD COLUMN last_round_usd INTEGER;
ALTER TABLE leads ADD COLUMN salary_band TEXT;

-- Track record (JSON arrays of small objects)
ALTER TABLE leads ADD COLUMN companies_json TEXT;
ALTER TABLE leads ADD COLUMN board_seats_json TEXT;
ALTER TABLE leads ADD COLUMN awards_json TEXT;
ALTER TABLE leads ADD COLUMN exits_json TEXT;

-- Workflow
ALTER TABLE leads ADD COLUMN priority TEXT;
ALTER TABLE leads ADD COLUMN owner_email TEXT;
ALTER TABLE leads ADD COLUMN next_action_at TEXT;
ALTER TABLE leads ADD COLUMN tags_json TEXT;
ALTER TABLE leads ADD COLUMN sector_focus_json TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_country_iso2 ON leads(country_iso2);
CREATE INDEX IF NOT EXISTS idx_leads_persona_role ON leads(persona_role);
CREATE INDEX IF NOT EXISTS idx_leads_owner_email ON leads(owner_email);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_linkedin_url ON leads(linkedin_url);
