-- Task #46: Add missing D1 indexes on hot sort/filter columns.
--
-- These columns drive nightly-cron scans and legacy-id lookups but lacked
-- usable indexes, forcing full table scans + temp-b-tree sorts. All
-- statements are `IF NOT EXISTS` so the migration is idempotent and safe
-- to re-apply (local + remote D1).
--
-- Next free slot after 379_system_health.sql; future migrations number
-- from 381.
--
-- DEVIATION NOTE (see commit message): the task asked for plain indexes on
-- `accounts.score_recomputed_at` and `leads.last_enriched_at`. Both hot
-- nightly queries, however, sort by `ORDER BY (col IS NULL) DESC, col ASC`
-- -- an EXPRESSION as the leading sort term -- so a plain single-column
-- index cannot satisfy the sort (verified via EXPLAIN QUERY PLAN: the plan
-- stays `SCAN ... | USE TEMP B-TREE FOR ORDER BY`). To meet the "query
-- plans use the new indexes" acceptance criterion WITHOUT rewriting the
-- queries (explicitly out of scope), the account/lead indexes are
-- expression indexes whose key exactly matches each ORDER BY. With them
-- the plan becomes `SCAN ... USING INDEX` with no temp b-tree, and the
-- LIMIT lets SQLite stop early after the matching (stale/NULL-first) rows.

-- 1. accounts nightly score-refresh scan (scheduled.ts, cron 15 3 * * *):
--      ... WHERE status NOT IN (...) AND (score_recomputed_at IS NULL
--          OR datetime(score_recomputed_at) < datetime('now','-1 day'))
--      ORDER BY score_recomputed_at IS NULL DESC, score_recomputed_at ASC
--      LIMIT 1000
CREATE INDEX IF NOT EXISTS idx_accounts_score_recomputed_at
  ON accounts(score_recomputed_at IS NULL DESC, score_recomputed_at ASC);

-- 2. leads nightly stale-re-enrichment scan (scheduled.ts):
--      ... ORDER BY (last_enriched_at IS NULL) DESC, last_enriched_at ASC
--      LIMIT 500
--    NOTE: the plain column index idx_leads_last_enriched (migration
--    030_discovery.sql) is retained -- it serves the sargable range query
--    in analytics_v2.aggregator.ts (last_enriched_at BETWEEN ? AND ?).
--    This new expression index serves the nightly ORDER BY scan that the
--    plain index cannot.
CREATE INDEX IF NOT EXISTS idx_leads_last_enriched_recency
  ON leads(last_enriched_at IS NULL DESC, last_enriched_at ASC);

-- 3. entity_legacy_map.legacy_id -- the table PRIMARY KEY is
--    (legacy_table, legacy_id), which already covers the common
--    `WHERE legacy_table = ? AND legacy_id = ?` lookups. This standalone
--    index supports legacy_id-only lookups (reverse resolution that does
--    not pin legacy_table). Verified used via EXPLAIN:
--    `SEARCH entity_legacy_map USING INDEX idx_entity_legacy_map_legacy_id`.
CREATE INDEX IF NOT EXISTS idx_entity_legacy_map_legacy_id
  ON entity_legacy_map(legacy_id);
