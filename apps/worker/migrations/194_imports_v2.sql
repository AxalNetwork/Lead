-- Task #2: PDF & spreadsheet mapper v2.
-- Adds per-tab outcome tracking, time-series firm_metrics, reusable column
-- mapping templates, and source-signature for template auto-apply.

-- summary_json holds {tabs:[{sheet,intent,rows_in,rows_imported,confidence,...}]}.
-- source_signature is a sha256 over normalized {filename_pattern, tab_names, header_set_per_tab}.
ALTER TABLE file_imports ADD COLUMN summary_json TEXT;
ALTER TABLE file_imports ADD COLUMN source_signature TEXT;
ALTER TABLE file_imports ADD COLUMN format TEXT;            -- csv|tsv|xlsx|ods|pdf-text|pdf-image|image|html|gsheet|airtable
ALTER TABLE file_imports ADD COLUMN tab_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_file_imports_signature ON file_imports(source_signature);

-- One row per parsed sheet/table within an upload. Lets the UI render tab
-- pills with per-tab maps + intents and lets import.ts route per-tab.
CREATE TABLE IF NOT EXISTS file_import_tabs (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES file_imports(id) ON DELETE CASCADE,
  tab_index INTEGER NOT NULL,
  sheet_name TEXT,
  page_number INTEGER,            -- for PDF tables
  intent TEXT,                    -- firms|firm_metrics|firm_geo|firm_kpi|notes|discard
  intent_subkind TEXT,            -- e.g. 'gov_fund' steers firms.kind
  intent_confidence REAL DEFAULT 0,
  row_count INTEGER DEFAULT 0,
  column_map_json TEXT,           -- {<header>: <"firms.name"|"firm_metrics.aum_usd"|"__skip__">}
  map_confidence_json TEXT,       -- {<header>: 0..1}
  rows_imported INTEGER DEFAULT 0,
  rows_skipped INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fit_import ON file_import_tabs(import_id);
CREATE INDEX IF NOT EXISTS idx_fit_intent ON file_import_tabs(intent);

-- Time-series KPIs per firm (AUM by year, deals/year, exits/year, geography
-- mix snapshots). Replaces shoe-horning into firm_portfolio.
CREATE TABLE IF NOT EXISTS firm_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,      -- aum_usd|deals_count|exits_count|new_funds|fund_size_usd|geo_pct|stage_pct|sector_pct
  metric_date TEXT NOT NULL,      -- ISO-ish date / period: 'YYYY-MM-DD'|'YYYY-MM'|'YYYY-Q#'|'YYYY'|'YTD'
  metric TEXT,                    -- legacy alias of metric_name (kept for compat with v1 readers)
  period TEXT,                    -- legacy alias of metric_date
  dimension TEXT,                 -- for breakdowns: country iso2, stage name, sector
  value_num REAL,                 -- numeric value
  value_text TEXT,                -- raw text (e.g. "$1.2B")
  source_url TEXT,
  imported_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_metrics
  ON firm_metrics(firm_id, metric_name, metric_date, COALESCE(dimension,''));
CREATE INDEX IF NOT EXISTS idx_firm_metrics_firm ON firm_metrics(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_metrics_metric ON firm_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_firm_metrics_date ON firm_metrics(metric_date);

-- Reusable column mapping templates. Auto-applied on next upload whose
-- source_signature matches. Operator-curated.
CREATE TABLE IF NOT EXISTS import_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_signature TEXT NOT NULL,
  format TEXT,
  tabs_json TEXT NOT NULL,        -- [{sheet,intent,intent_subkind,column_map,sample_headers}]
  created_by TEXT,
  use_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_import_templates_sig ON import_templates(source_signature);
