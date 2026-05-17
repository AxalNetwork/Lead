-- Task #2 (this task): Monitoring, alerts, watchlists, webhooks.
--
-- Schema layout:
--   watchlists           — manual or smart (filter-driven) groupings.
--   watchlist_members    — entity ↔ watchlist join.
--   alert_rules          — fixed-enum trigger + channel config.
--   alert_events         — emitted events with delivery state machine.
--   entity_snapshots     — canonical summary fingerprints (one per change).
--   digest_queue         — pending rolled-up notifications.
--
-- All tables filter by `owner_email` derived from the Cloudflare Access JWT.
-- The `trigger_kind` enum is closed; new kinds require code + migration.

CREATE TABLE IF NOT EXISTS watchlists (
  id              TEXT PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  is_smart        INTEGER NOT NULL DEFAULT 0,
  filter_json     TEXT,            -- saved querystring/filter for smart lists
  entity_kind     TEXT,            -- 'person' | 'org' | NULL (mixed)
  member_count    INTEGER NOT NULL DEFAULT 0,
  last_changed_at TEXT,            -- updated when membership changes
  last_evaluated_at TEXT,          -- smart-list re-eval timestamp
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watchlists_owner ON watchlists(owner_email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlists_owner_name ON watchlists(owner_email, name);
CREATE INDEX IF NOT EXISTS idx_watchlists_smart ON watchlists(is_smart, last_evaluated_at);

CREATE TABLE IF NOT EXISTS watchlist_members (
  watchlist_id  TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  added_by      TEXT,
  source        TEXT NOT NULL DEFAULT 'manual'  -- 'manual' | 'smart'
                CHECK (source IN ('manual','smart')),
  PRIMARY KEY (watchlist_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_wmembers_entity ON watchlist_members(entity_id);
CREATE INDEX IF NOT EXISTS idx_wmembers_watchlist ON watchlist_members(watchlist_id);

CREATE TABLE IF NOT EXISTS alert_rules (
  id                    TEXT PRIMARY KEY,
  owner_email           TEXT NOT NULL,
  name                  TEXT NOT NULL,
  watchlist_id          TEXT,                  -- attached to whole list, OR
  entity_id             TEXT,                  -- attached to one entity
  trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN (
    'new_employer','title_change','new_investment','new_portfolio_addition',
    'new_news_item','adverse_media','funding_event','executive_change',
    'new_tweet','new_podcast','new_post','dd_finding_new','dd_score_change',
    'fit_score_change','intent_score_change','prediction_above_threshold',
    'handle_added','relationship_change','geo_change','any_change'
  )),
  trigger_config_json   TEXT,                  -- per-kind thresholds, filters
  channel               TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN (
    'in_app','email','slack','webhook','digest'
  )),
  channel_config_json   TEXT,                  -- {email:[], slack_url, webhook_url, webhook_secret}
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
CREATE INDEX IF NOT EXISTS idx_alert_rules_owner    ON alert_rules(owner_email);
CREATE INDEX IF NOT EXISTS idx_alert_rules_wl_act   ON alert_rules(watchlist_id, is_active);
CREATE INDEX IF NOT EXISTS idx_alert_rules_ent_act  ON alert_rules(entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_alert_rules_kind     ON alert_rules(trigger_kind);

CREATE TABLE IF NOT EXISTS alert_events (
  id                  TEXT PRIMARY KEY,
  owner_email         TEXT NOT NULL,
  rule_id             TEXT NOT NULL,
  watchlist_id        TEXT,
  entity_id           TEXT NOT NULL,
  trigger_kind        TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  dedupe_hash         TEXT NOT NULL,            -- sha256(rule_id|entity_id|kind|dedupe_key)
  title               TEXT NOT NULL,
  body                TEXT,
  diff_json           TEXT,                     -- FieldDiff[]
  payload_json        TEXT,                     -- full evaluator payload
  channel             TEXT NOT NULL,
  delivery_status     TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN (
    'pending','delivered','failed','suppressed_duplicate','rate_limited','digested'
  )),
  delivery_attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  delivery_log_json   TEXT,                     -- [{ts,channel,status,error}]
  occurred_at         TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at        TEXT,
  read_at             TEXT,
  acked_at            TEXT,
  acked_by            TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_owner_occ  ON alert_events(owner_email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule       ON alert_events(rule_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_entity     ON alert_events(entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_status     ON alert_events(delivery_status);
CREATE INDEX IF NOT EXISTS idx_alert_events_unread     ON alert_events(owner_email, read_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_dedupe     ON alert_events(dedupe_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_next_attempt ON alert_events(next_attempt_at)
  WHERE delivery_status = 'pending';

CREATE TABLE IF NOT EXISTS entity_snapshots (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  summary_json    TEXT NOT NULL,
  summary_hash    TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  snapshot_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, summary_hash)
);
CREATE INDEX IF NOT EXISTS idx_entity_snap_recent ON entity_snapshots(entity_id, snapshot_at DESC);

-- Tracks when each entity was last evaluated by the MonitorEntityWorkflow.
-- Separate from snapshot creation so we record evaluation time even when
-- the fingerprint did not change (idempotency anchor).
CREATE TABLE IF NOT EXISTS entity_monitor_state (
  entity_id          TEXT PRIMARY KEY,
  last_evaluated_at  TEXT NOT NULL,
  last_hash          TEXT
);
CREATE INDEX IF NOT EXISTS idx_emonstate_eval ON entity_monitor_state(last_evaluated_at);

CREATE TABLE IF NOT EXISTS digest_queue (
  id            TEXT PRIMARY KEY,
  owner_email   TEXT NOT NULL,
  watchlist_id  TEXT,
  event_id      TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','sent','skipped','failed'
  )),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_digest_due ON digest_queue(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_digest_owner ON digest_queue(owner_email, scheduled_for);
