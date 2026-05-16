-- Task #2: Per-share Airtable column schema cache. The Airtable importer
-- recovers `data.table.columns[]` on every run, but if a future import
-- fails to parse `readSharedViewData` (Airtable ships a new payload
-- shape) we fall back to the last-known good schema rather than dropping
-- typed cells silently. Cache is keyed by (shareId, tableId).
--
-- Universe explore shares additionally cache the resolved sharedBase
-- URL + marketing context (title/description/categories) so re-imports
-- always emit the correct `source_collection=explore.{slug}` tag.

CREATE TABLE IF NOT EXISTS airtable_share_schema_cache (
  share_id     TEXT NOT NULL,
  table_id     TEXT NOT NULL,
  schema_json  TEXT NOT NULL,
  context_json TEXT,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (share_id, table_id)
);
