-- Task #19: Custom CSV export builder.
--
-- Stores reusable column sets for the export builder. The five built-in
-- templates seeded below are inserted with `created_by='system'` so the
-- UI can render them as presets without depending on a per-user template
-- ever being saved.
--
-- columns_json schema:
--   [{ "field": "<entity-column-or-virtual>",
--      "header": "<optional override>",
--      "transform": "<optional, see EXPORT_TRANSFORMS>" }, ...]
--
-- filter_json is a free-form object; the route validates per-entity.

CREATE TABLE IF NOT EXISTS export_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('leads','firms','firm_people','portfolio')),
  columns_json TEXT NOT NULL,
  filter_json TEXT,
  format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','tsv','xlsx','json')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_export_templates_entity ON export_templates(entity);
CREATE INDEX IF NOT EXISTS idx_export_templates_created_by ON export_templates(created_by);

-- Five built-in presets. `INSERT OR IGNORE` so re-running the migration
-- doesn't disturb operator edits (templates are looked up by slug).

INSERT OR IGNORE INTO export_templates (slug, name, entity, columns_json, filter_json, format, created_by, created_at)
VALUES
('minimal_contact', 'Minimal Contact', 'leads',
 '[{"field":"name"},{"field":"primary_email"},{"field":"org"},{"field":"title"}]',
 '{"include_merged":false}', 'csv', 'system', datetime('now')),

('outbound_email', 'Outbound Email', 'leads',
 '[{"field":"name"},{"field":"primary_email"},{"field":"primary_linkedin"},{"field":"org"},{"field":"title"},{"field":"persona_role"},{"field":"country_iso2","header":"country"},{"field":"source_url"}]',
 '{"status":"approved","include_merged":false,"has_email":true}', 'csv', 'system', datetime('now')),

('vc_research_full', 'VC Research (Full)', 'firms',
 '[{"field":"name"},{"field":"kind"},{"field":"website"},{"field":"hq_city"},{"field":"hq_country_iso2"},{"field":"sectors_json","transform":"pipe_join"},{"field":"stages_json","transform":"pipe_join"},{"field":"check_size_typical_usd"},{"field":"aum_usd"},{"field":"portfolio_count_actual"},{"field":"partner_count"},{"field":"top_partner_name"},{"field":"thesis"},{"field":"linkedin_url"},{"field":"crunchbase_url"}]',
 '{}', 'csv', 'system', datetime('now')),

('airtable_compatible', 'Airtable Compatible', 'firms',
 '[{"field":"name","header":"Firm"},{"field":"stages_json","header":"Stage (They finance)","transform":"pipe_join"},{"field":"sectors_json","header":"Areas of interest","transform":"pipe_join"},{"field":"check_size_typical_usd","header":"Check size"},{"field":"lead_or_co","header":"Lead/co-invest"},{"field":"thesis","header":"Notes"},{"field":"hq_city","header":"Location"},{"field":"last_modified","header":"Last modified"}]',
 '{}', 'csv', 'system', datetime('now')),

('portfolio_dump', 'Portfolio Dump', 'portfolio',
 '[{"field":"firm_name"},{"field":"company_name"},{"field":"company_domain"},{"field":"investment_year"},{"field":"stage"},{"field":"amount_usd"},{"field":"is_lead","transform":"bool_yn"},{"field":"outcome"},{"field":"exit_value_usd"},{"field":"company_url"}]',
 '{}', 'csv', 'system', datetime('now'));
