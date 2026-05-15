-- Task #24: extend the export builder to investors + companies entities.
-- The original 100_export_templates.sql had a CHECK constraint locking
-- `entity` to (leads, firms, firm_people, portfolio). SQLite can't ALTER
-- a CHECK in place, so we rebuild the table preserving the rows.

CREATE TABLE export_templates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('leads','firms','firm_people','portfolio','investors','companies')),
  columns_json TEXT NOT NULL,
  filter_json TEXT,
  format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','tsv','xlsx','json')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO export_templates_new (id, slug, name, entity, columns_json, filter_json, format, created_by, created_at)
  SELECT id, slug, name, entity, columns_json, filter_json, format, created_by, created_at FROM export_templates;

DROP TABLE export_templates;
ALTER TABLE export_templates_new RENAME TO export_templates;
CREATE INDEX IF NOT EXISTS idx_export_templates_entity ON export_templates(entity);
CREATE INDEX IF NOT EXISTS idx_export_templates_created_by ON export_templates(created_by);

-- Built-in presets for the new entities. The two slugs required by the
-- task spec — `investor_full` and `company_due_diligence` — are seeded
-- first; the additional outreach/funding/exits presets are convenience
-- wrappers operators have asked for.
INSERT OR IGNORE INTO export_templates (slug, name, entity, columns_json, filter_json, format, created_by, created_at)
VALUES
('investor_full', 'Investor (Full)', 'investors',
 '[{"field":"name"},{"field":"investor_kind"},{"field":"org"},{"field":"title"},{"field":"thesis"},{"field":"sweet_spot_stage"},{"field":"stage_focus_json","transform":"pipe_join"},{"field":"sector_focus_slugs_json","transform":"pipe_join"},{"field":"geo_focus_json","transform":"pipe_join"},{"field":"check_size_min_usd"},{"field":"check_size_max_usd"},{"field":"check_size_typical_usd"},{"field":"investment_count"},{"field":"unicorn_count"},{"field":"exit_count"},{"field":"avg_check_usd"},{"field":"total_deployed_usd"},{"field":"board_seats_count"},{"field":"primary_email"},{"field":"primary_phone"},{"field":"primary_linkedin"},{"field":"twitter_url"},{"field":"github_url"},{"field":"signal_nfx_url"},{"field":"crunchbase_url"},{"field":"wikipedia_url"},{"field":"office_hours_url"},{"field":"pitch_form_url"},{"field":"calendly_url"},{"field":"city"},{"field":"region"},{"field":"country_iso2"},{"field":"current_fund_name"},{"field":"current_role_title"}]',
 '{}', 'csv', 'system', datetime('now')),

('company_due_diligence', 'Company Due Diligence', 'companies',
 '[{"field":"name"},{"field":"legal_name"},{"field":"domain"},{"field":"website"},{"field":"description"},{"field":"status"},{"field":"founded_year"},{"field":"hq_city"},{"field":"hq_region"},{"field":"hq_country_iso2"},{"field":"industries_json","transform":"pipe_join"},{"field":"stage"},{"field":"total_funding_usd"},{"field":"last_round_usd"},{"field":"last_round_at"},{"field":"last_round_stage"},{"field":"valuation_usd"},{"field":"unicorn","transform":"bool_yn"},{"field":"exit_kind"},{"field":"exit_date"},{"field":"exit_value_usd"},{"field":"acquirer_name"},{"field":"ticker"},{"field":"employees"},{"field":"linkedin_url"},{"field":"crunchbase_url"},{"field":"twitter_handle"},{"field":"github_org"},{"field":"pitchbook_url"},{"field":"sec_cik"},{"field":"investor_count"},{"field":"round_count"},{"field":"founder_count"},{"field":"source_url"},{"field":"last_enriched_at"}]',
 '{}', 'csv', 'system', datetime('now')),

('investor_outreach', 'Investor Outreach', 'investors',
 '[{"field":"name"},{"field":"investor_kind"},{"field":"org"},{"field":"title"},{"field":"primary_email"},{"field":"linkedin_url"},{"field":"city"},{"field":"country_iso2"},{"field":"sweet_spot_stage"},{"field":"check_size_typical_usd"},{"field":"investment_count"},{"field":"unicorn_count"}]',
 '{}', 'csv', 'system', datetime('now')),

('investor_research_full', 'Investor Research (Full)', 'investors',
 '[{"field":"name"},{"field":"investor_kind"},{"field":"org"},{"field":"title"},{"field":"thesis"},{"field":"sweet_spot_stage"},{"field":"stage_focus_json","transform":"pipe_join"},{"field":"sector_focus_slugs_json","transform":"pipe_join"},{"field":"geo_focus_json","transform":"pipe_join"},{"field":"check_size_min_usd"},{"field":"check_size_max_usd"},{"field":"check_size_typical_usd"},{"field":"investment_count"},{"field":"unicorn_count"},{"field":"exit_count"},{"field":"avg_check_usd"},{"field":"total_deployed_usd"},{"field":"linkedin_url"},{"field":"twitter_url"},{"field":"signal_nfx_url"},{"field":"crunchbase_url"},{"field":"city"},{"field":"country_iso2"}]',
 '{}', 'csv', 'system', datetime('now')),

('company_funding', 'Company Funding', 'companies',
 '[{"field":"name"},{"field":"domain"},{"field":"stage"},{"field":"total_funding_usd"},{"field":"last_round_usd"},{"field":"last_round_stage"},{"field":"last_round_at"},{"field":"valuation_usd"},{"field":"unicorn","transform":"bool_yn"},{"field":"hq_city"},{"field":"hq_country_iso2"},{"field":"industries_json","transform":"pipe_join"},{"field":"founded_year"},{"field":"employees"}]',
 '{}', 'csv', 'system', datetime('now')),

('company_exits', 'Company Exits', 'companies',
 '[{"field":"name"},{"field":"domain"},{"field":"exit_kind"},{"field":"exit_date"},{"field":"exit_value_usd"},{"field":"acquirer_name"},{"field":"ticker"},{"field":"total_funding_usd"},{"field":"hq_country_iso2"}]',
 '{"status":"acquired"}', 'csv', 'system', datetime('now'));
