-- Task #2 follow-up: harden article dedupe under concurrency.
--
-- The application layer (`persistStubIfNew` in news/refresh.ts) already
-- checks both `url` and `url_canonical` before insert, but two concurrent
-- ingests of the same article with different tracker params could race
-- past that check. A partial-unique index on `url_canonical` (skipping
-- NULL/empty values to remain back-compatible with any legacy rows)
-- enforces dedupe at the DB tier as well.
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_items_url_canonical_unique
  ON news_items(url_canonical)
  WHERE url_canonical IS NOT NULL AND url_canonical <> '';
