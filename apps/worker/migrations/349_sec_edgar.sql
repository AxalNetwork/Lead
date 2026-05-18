-- Task #1: SEC EDGAR Deep Adapter — raw filing storage + new predicates.
--
-- All five tables key off `accession_no` (the SEC's 18-digit globally-unique
-- filing identifier), which guarantees idempotent re-ingest. The crawler
-- engine archives the raw HTML/XML to R2 separately; these tables hold the
-- structured per-form payloads the EDGAR parsers extract.

-- ============================================================
-- sec_filings: one row per filing the discovery walker has seen.
-- Acts as both a dedup table and a join surface for the per-form tables.
-- ============================================================
CREATE TABLE IF NOT EXISTS sec_filings (
  accession_no      TEXT PRIMARY KEY,           -- e.g. 0001234567-24-000001
  cik               TEXT NOT NULL,              -- zero-padded 10-digit
  form_type         TEXT NOT NULL,              -- 10-K | 10-Q | 8-K | S-1 | 13F-HR | SC 13D | SC 13G | 4 | D | ADV | PF | …
  filer_name        TEXT,                       -- registrant / filer display name
  filed_at          TEXT,                       -- ISO date the filing was accepted by EDGAR
  period_of_report  TEXT,                       -- ISO date covering the reporting period
  filing_url        TEXT NOT NULL,              -- canonical /Archives/edgar/data/... index page
  raw_url           TEXT,                       -- raw filing URL (alias of filing_url; spec field)
  primary_doc_url   TEXT,                       -- primary document URL (10-K body, 13F XML, …)
  parsed_payload_json TEXT,                     -- structured per-form payload as serialized JSON
  entity_id         TEXT,                       -- cross-ref to u_entities once resolved
  ingest_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | parsed | failed
  errors            TEXT,                       -- parse/ingest error messages (NULL on success)
  parsed_at         TEXT,
  discovered_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source            TEXT NOT NULL DEFAULT 'edgar_daily_index' -- edgar_daily_index | edgar_fts | edgar_rss | manual
);
CREATE INDEX IF NOT EXISTS idx_secf_cik       ON sec_filings(cik);
CREATE INDEX IF NOT EXISTS idx_secf_form      ON sec_filings(form_type, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_secf_cik_form  ON sec_filings(cik, form_type);
CREATE INDEX IF NOT EXISTS idx_secf_status    ON sec_filings(ingest_status, discovered_at);
CREATE INDEX IF NOT EXISTS idx_secf_entity    ON sec_filings(entity_id) WHERE entity_id IS NOT NULL;

-- ============================================================
-- sec_form_adv_funds: one row per fund/managed-vehicle disclosed on Form ADV
-- Schedule D Section 7.B.(1). One Form ADV typically lists N funds.
-- ============================================================
CREATE TABLE IF NOT EXISTS sec_form_adv_funds (
  id                   TEXT PRIMARY KEY,
  accession_no         TEXT NOT NULL,
  adviser_crd          TEXT,                   -- adviser CRD#
  adviser_sec_no       TEXT,                   -- SEC file no e.g. 801-12345
  adviser_name         TEXT NOT NULL,
  fund_name            TEXT NOT NULL,
  fund_id_807          TEXT,                   -- SEC fund ID (807-XXXXXXXX)
  fund_type            TEXT,                   -- hedge_fund | private_equity_fund | venture_capital_fund | real_estate_fund | …
  gross_asset_value    INTEGER,                -- USD
  beneficial_owners    INTEGER,
  minimum_investment   INTEGER,                -- USD
  master_feeder        TEXT,                   -- master | feeder | neither
  custodian            TEXT,
  auditor              TEXT,
  prime_broker         TEXT,
  state_country        TEXT,
  entity_id            TEXT,                   -- cross-ref to fund entity once created
  adviser_entity_id    TEXT,                   -- cross-ref to adviser entity
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (accession_no, fund_name, fund_id_807)
);
CREATE INDEX IF NOT EXISTS idx_advfund_crd      ON sec_form_adv_funds(adviser_crd);
CREATE INDEX IF NOT EXISTS idx_advfund_acc      ON sec_form_adv_funds(accession_no);
CREATE INDEX IF NOT EXISTS idx_advfund_entity   ON sec_form_adv_funds(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_advfund_adviser  ON sec_form_adv_funds(adviser_entity_id) WHERE adviser_entity_id IS NOT NULL;

-- ============================================================
-- sec_form_d_rounds: one row per Form D Reg D private placement filing.
-- Each filing corresponds to one round/offering.
-- ============================================================
CREATE TABLE IF NOT EXISTS sec_form_d_rounds (
  id                       TEXT PRIMARY KEY,
  accession_no             TEXT NOT NULL,
  issuer_cik               TEXT,
  issuer_name              TEXT NOT NULL,
  issuer_jurisdiction      TEXT,
  issuer_year_of_inc       INTEGER,
  industry_group           TEXT,
  entity_type              TEXT,                -- LLC | LP | Corp | …
  total_offering_amount    INTEGER,             -- USD (NULL when 'Indefinite')
  total_amount_sold        INTEGER,             -- USD
  total_remaining          INTEGER,             -- USD
  minimum_investment       INTEGER,             -- USD per investor
  total_investors          INTEGER,
  date_of_first_sale       TEXT,                -- ISO date
  exemption_claimed        TEXT,                -- 506(b) | 506(c) | 504 | 4(a)(5) | …
  related_persons_json     TEXT NOT NULL DEFAULT '[]', -- JSON array of {name, role, address?}
  is_amendment             INTEGER NOT NULL DEFAULT 0,
  entity_id                TEXT,                -- cross-ref to issuer entity
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (accession_no)
);
CREATE INDEX IF NOT EXISTS idx_formd_issuer    ON sec_form_d_rounds(issuer_cik);
CREATE INDEX IF NOT EXISTS idx_formd_date      ON sec_form_d_rounds(date_of_first_sale DESC);
CREATE INDEX IF NOT EXISTS idx_formd_industry  ON sec_form_d_rounds(industry_group, date_of_first_sale DESC);
CREATE INDEX IF NOT EXISTS idx_formd_entity    ON sec_form_d_rounds(entity_id) WHERE entity_id IS NOT NULL;

-- ============================================================
-- sec_13f_holdings: one row per security held per 13F filing.
-- A single 13F-HR filing typically lists thousands of positions.
-- ============================================================
CREATE TABLE IF NOT EXISTS sec_13f_holdings (
  id                   TEXT PRIMARY KEY,
  accession_no         TEXT NOT NULL,
  filer_cik            TEXT NOT NULL,
  filer_name           TEXT,
  period_of_report     TEXT NOT NULL,           -- ISO quarter-end date
  cusip                TEXT NOT NULL,
  issuer_name          TEXT,
  title_of_class       TEXT,
  value_usd            INTEGER,                 -- (×1000 per SEC; we store the actual USD)
  shares_or_principal  INTEGER,
  share_type           TEXT,                    -- SH | PRN
  put_call             TEXT,                    -- PUT | CALL | NULL
  investment_discretion TEXT,                   -- SOLE | DFND | OTR
  voting_sole          INTEGER,
  voting_shared        INTEGER,
  voting_none          INTEGER,
  filer_entity_id      TEXT,                    -- cross-ref to filer entity
  issuer_entity_id     TEXT,                    -- cross-ref to issuer entity
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (accession_no, cusip, put_call, share_type)
);
CREATE INDEX IF NOT EXISTS idx_13f_filer    ON sec_13f_holdings(filer_cik, period_of_report DESC);
CREATE INDEX IF NOT EXISTS idx_13f_cusip    ON sec_13f_holdings(cusip, period_of_report DESC);
CREATE INDEX IF NOT EXISTS idx_13f_acc      ON sec_13f_holdings(accession_no);

-- ============================================================
-- sec_insider_trades: one row per Form 4 / 13D / 13G ownership event.
-- Captures beneficial ownership changes by insiders and 5%+ shareholders.
-- ============================================================
CREATE TABLE IF NOT EXISTS sec_insider_trades (
  id                   TEXT PRIMARY KEY,
  accession_no         TEXT NOT NULL,
  form_type            TEXT NOT NULL,           -- 4 | SC 13D | SC 13G | 13D/A | 13G/A
  filer_cik            TEXT NOT NULL,
  filer_name           TEXT,
  reporting_owner_cik  TEXT,
  reporting_owner_name TEXT,
  issuer_cik           TEXT,
  issuer_name          TEXT,
  issuer_ticker        TEXT,
  is_director          INTEGER,
  is_officer           INTEGER,
  is_ten_percent_owner INTEGER,
  is_other             INTEGER,
  officer_title        TEXT,
  transaction_date     TEXT,                    -- ISO date
  transaction_code     TEXT,                    -- P (purchase), S (sale), A (award), …
  shares               REAL,
  price_per_share      REAL,
  shares_after         REAL,
  percent_of_class     REAL,                    -- for 13D/13G
  ownership_form       TEXT,                    -- D (direct) | I (indirect)
  filer_entity_id      TEXT,
  issuer_entity_id     TEXT,
  owner_entity_id      TEXT,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (accession_no, reporting_owner_cik, transaction_date, transaction_code, shares)
);
CREATE INDEX IF NOT EXISTS idx_insider_issuer ON sec_insider_trades(issuer_cik, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_insider_owner  ON sec_insider_trades(reporting_owner_cik, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_insider_form   ON sec_insider_trades(form_type, transaction_date DESC);
-- Entity-id query path (spec asks for an index keyed by the resolved
-- reporter entity + txn date). Our column is owner_entity_id /
-- issuer_entity_id (set post-xref); index both so the persona-match
-- and entity-page queries can scan recent trades for a person/org
-- without falling back to the CIK indexes above.
CREATE INDEX IF NOT EXISTS idx_insider_owner_entity ON sec_insider_trades(owner_entity_id, transaction_date DESC) WHERE owner_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insider_issuer_entity ON sec_insider_trades(issuer_entity_id, transaction_date DESC) WHERE issuer_entity_id IS NOT NULL;

-- ============================================================
-- Predicate registry rows for new SEC-EDGAR-emitted facts. Mirrors the
-- PREDICATE_REGISTRY append in profile-predicates.ts (two-file change
-- enforced by test/profile.test.mjs).
-- ============================================================
INSERT OR IGNORE INTO predicate_registry (predicate, label, icon, formatter, category, value_type, description) VALUES
  ('sec.cik',              'SEC CIK',             'hash',        'text', 'identity', 'text',         'SEC Central Index Key (10-digit, zero-padded).'),
  ('sec.crd',              'SEC CRD',             'hash',        'text', 'identity', 'text',         'Investment Adviser CRD# from Form ADV.'),
  ('sec.cusip',            'CUSIP',               'hash',        'text', 'identity', 'text',         'Committee on Uniform Securities Identification Procedures code.'),
  ('sec.ticker',           'Ticker',              'trending-up', 'badge','identity', 'text',         'Public ticker symbol.'),
  ('sec.sec_file_number',  'SEC file number',     'hash',        'text', 'identity', 'text',         'SEC file number (e.g. 801-12345 for advisers).'),
  ('sec.fund_id_807',      'SEC fund ID',         'hash',        'text', 'identity', 'text',         'SEC fund identifier (807-XXXXXXXX).'),
  ('aum_usd',              'AUM (USD)',           'dollar-sign', 'usd',  'firm',     'currency_usd', 'Assets under management in USD.'),
  ('sec.form_adv.filed_at',         'Last Form ADV filed', 'calendar',     'date', 'firm', 'date',         'Most recent Form ADV acceptance date.'),
  ('sec.form_adv.fund',             'Form ADV fund',       'briefcase',    'json', 'firm', 'json',         'Fund disclosed on Schedule D §7.B.(1).'),
  ('sec.form_d.round',              'Form D round',        'dollar-sign',  'json', 'firm', 'json',         'Private placement disclosed on Form D.'),
  ('sec.form_d.issuer_industry',    'Form D industry',     'layers',       'badge','firm', 'text',         'Industry group declared on Form D.'),
  ('sec.13f.holding',               '13F holding',         'briefcase',    'json', 'firm', 'json',         'Equity position disclosed on Form 13F-HR.'),
  ('sec.13f.filer_aum_usd',         '13F filer AUM (USD)', 'dollar-sign',  'usd',  'firm', 'currency_usd', 'Aggregate USD value of 13F holdings (proxy AUM).'),
  ('sec.13d.beneficial_owner',      '13D beneficial owner','users',        'json', 'firm', 'json',         'Schedule 13D 5%+ beneficial-ownership disclosure.'),
  ('sec.form4.insider_trade',       'Insider trade',       'arrow-up-down','json', 'firm', 'json',         'Form 4 §16 insider transaction.'),
  ('sec.form4.officer_title',       'Officer title',       'briefcase',    'text', 'career','text',        'Officer title declared on Form 4 (when reporter is officer).'),
  ('sec.s1.ipo_intent',             'S-1 IPO intent',      'rocket',       'text', 'firm', 'text',         'Company filed Form S-1 (IPO registration).'),
  ('sec.s1.underwriter',            'IPO underwriter',     'briefcase',    'text', 'firm', 'text',         'Underwriter listed on Form S-1.'),
  ('sec.8k.material_event',         '8-K material event',  'alert-circle', 'json', 'firm', 'json',         'Form 8-K current report item.'),
  ('sec.10k.revenue_usd',           '10-K revenue (USD)',  'dollar-sign',  'usd',  'firm', 'currency_usd', 'Annual revenue from Form 10-K.'),
  ('sec.10k.net_income_usd',        '10-K net income',     'dollar-sign',  'usd',  'firm', 'currency_usd', 'Net income from Form 10-K.'),
  ('sec.10k.fiscal_year_end',       '10-K fiscal year-end','calendar',     'date', 'firm', 'date',         'Fiscal year-end from Form 10-K.'),
  ('sec.10k.executive',             '10-K executive',      'users',        'json', 'firm', 'json',         'Named executive officer compensation from Form 10-K.'),
  ('sec.pf.fund',                   'Form PF fund',        'briefcase',    'json', 'firm', 'json',         'Private fund disclosure from Form PF (large private fund adviser).'),
  ('sec.gp_disclosed',              'GP disclosed (SEC)',  'user-check',   'text', 'firm', 'text',         'GP / control-person disclosed on a SEC filing.');
