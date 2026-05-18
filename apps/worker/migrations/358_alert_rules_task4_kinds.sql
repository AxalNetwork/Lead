-- Task #4: extend alert_rules.trigger_kind CHECK constraint to include
-- the four new dashboard-driven kinds. Code (monitoring/types.ts +
-- triggers/index.ts) already references these kinds; without this
-- migration any POST creating one of the five required saved alerts
-- would pass API validation and then fail at INSERT.
--
-- SQLite can't ALTER a CHECK constraint, so we recreate the table
-- preserving all rows and re-create the original three indexes.

PRAGMA foreign_keys = OFF;

CREATE TABLE alert_rules__new (
  id                    TEXT PRIMARY KEY,
  owner_email           TEXT NOT NULL,
  name                  TEXT NOT NULL,
  watchlist_id          TEXT,
  entity_id             TEXT,
  trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN (
    'new_employer','title_change','new_investment','new_portfolio_addition',
    'new_news_item','adverse_media','funding_event','executive_change',
    'new_tweet','new_podcast','new_post','dd_finding_new','dd_score_change',
    'fit_score_change','intent_score_change','prediction_above_threshold',
    'handle_added','relationship_change','geo_change','any_change',
    -- Task #4 additions:
    'partner_movement_match','new_fund_match','sec_filing_match','pe_deal_match'
  )),
  trigger_config_json   TEXT,
  channel               TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN (
    'in_app','email','slack','webhook','digest'
  )),
  channel_config_json   TEXT,
  digest_frequency      TEXT NOT NULL DEFAULT 'daily' CHECK (digest_frequency IN (
    'realtime','hourly','daily','weekly','off'
  )),
  dedupe_window_seconds INTEGER NOT NULL DEFAULT 3600,
  is_active             INTEGER NOT NULL DEFAULT 1,
  last_fired_at         TEXT,
  fire_count            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO alert_rules__new
  SELECT id, owner_email, name, watchlist_id, entity_id, trigger_kind,
         trigger_config_json, channel, channel_config_json, digest_frequency,
         dedupe_window_seconds, is_active, last_fired_at, fire_count,
         created_at, updated_at
    FROM alert_rules;

DROP TABLE alert_rules;
ALTER TABLE alert_rules__new RENAME TO alert_rules;

CREATE INDEX IF NOT EXISTS idx_alert_rules_owner   ON alert_rules(owner_email);
CREATE INDEX IF NOT EXISTS idx_alert_rules_wl_act  ON alert_rules(watchlist_id, is_active);
CREATE INDEX IF NOT EXISTS idx_alert_rules_ent_act ON alert_rules(entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_alert_rules_kind    ON alert_rules(trigger_kind);

PRAGMA foreign_keys = ON;
