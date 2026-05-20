-- Task #6 repair migration.
--
-- Migration 357_dashboards.sql failed in production with
-- "no such column: owner_email" because the prod D1 already had a
-- pre-existing dashboard_snapshots table (created out-of-band before
-- 357 shipped) with an older schema lacking the owner_email column.
-- The CREATE TABLE IF NOT EXISTS in 357 was a no-op against the
-- pre-existing table, then the CREATE INDEX on (owner_email, ...)
-- failed and rolled back the migration. Migrations 358..372 stayed
-- pending behind it.
--
-- Prod was cleaned up out-of-band by .github/workflows/d1-prod-repair.yml
-- (DROP TABLE dashboard_snapshots) so 357 can re-run cleanly. This
-- migration is the belt-and-suspenders that enforces the canonical
-- schema regardless of what state the table was previously in. It is
-- safe to re-run on every D1 (dev, prod, fresh) because every
-- statement is idempotent.
--
-- Note: per replit.md operational note, migration 357 is left
-- UNTOUCHED so dev/test DBs that already applied it cleanly do not
-- re-execute it. This new migration runs after 372 and is the new
-- canonical-state enforcer for dashboard_snapshots.

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id              TEXT PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  page            TEXT NOT NULL,
  filters_json    TEXT NOT NULL,
  payload_json    TEXT,
  payload_uri     TEXT,
  row_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_owner
  ON dashboard_snapshots(owner_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_page
  ON dashboard_snapshots(page, created_at DESC);
