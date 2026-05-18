-- Task #3 (third-pass review fix): smart_frontier NULL-dedup + drain bookkeeping.
--
-- The original table used `UNIQUE (profile_type_id, url_canonical)`.
-- SQLite treats NULL as distinct in unique constraints, so untyped
-- rows (profile_type_id IS NULL) bypass the dedup and the same URL can
-- be inserted on every expansion. Replace with an expression-based
-- unique index that treats NULL as the empty string so dedup is honored
-- for both typed and untyped rows.

-- We can't drop the auto-index that backs the original
-- `UNIQUE (profile_type_id, url_canonical)` constraint (SQLite rejects
-- DROP INDEX on it). Instead we add a parallel expression-based unique
-- index. For typed rows (profile_type_id IS NOT NULL) both indexes
-- enforce dedup identically. For untyped rows the original treats each
-- NULL as distinct, but this index uses '' so it dedupes correctly.

CREATE UNIQUE INDEX IF NOT EXISTS uq_sf_type_canon
  ON smart_frontier (COALESCE(profile_type_id, ''), url_canonical);
