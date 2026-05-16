-- Per-share Folk groupSchema cache. The Folk importer recovers the
-- column field-map from `__NEXT_DATA__` on every run, but if a future
-- import fails to parse the bootstrap (e.g. Folk ships a new SPA shell),
-- we want to fall back to the last-known good schema for that share id
-- rather than dropping relation columns silently. Cache is keyed by the
-- 20+ char base62 share id parsed out of `app.folk.app/shared/...`.

CREATE TABLE IF NOT EXISTS folk_share_schema_cache (
  share_id    TEXT PRIMARY KEY,
  schema_json TEXT NOT NULL,
  group_id    TEXT,
  fetched_at  TEXT NOT NULL
);
