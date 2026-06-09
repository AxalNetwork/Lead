-- Task #63: chunked, resumable legacy file imports.
--
-- processImportFile previously ran every row of every tab in a single queue
-- invocation. The leads path is subrequest-heavy per row (DNC scrub +
-- resolveIncoming fact chain + match/merge), so even a few hundred rows could
-- exceed the per-invocation subrequest budget and the isolate was killed
-- BEFORE the try/catch could set status='error' — leaving the row stuck at
-- 'importing' forever. These columns let the import checkpoint its progress
-- and resume across invocations (and let a watchdog recover stalls).

-- Resume cursor + watchdog bookkeeping on the parent import.
ALTER TABLE file_imports ADD COLUMN import_phase TEXT DEFAULT 'rows';   -- 'rows' | 'urls' | 'done'
ALTER TABLE file_imports ADD COLUMN import_cursor_tab INTEGER DEFAULT 0; -- tab_index in progress (rows phase)
ALTER TABLE file_imports ADD COLUMN import_cursor_row INTEGER DEFAULT 0; -- row offset within cursor tab (rows phase) / url offset (urls phase)
ALTER TABLE file_imports ADD COLUMN import_attempts INTEGER DEFAULT 0;   -- watchdog stall recoveries; reset to 0 on every progress checkpoint

-- Per-tab cumulative counters so a finalize after N chunks can rebuild the
-- summary purely from the DB (no reliance on in-memory state that resets each
-- invocation). rows_imported / rows_skipped already exist (migration 194).
ALTER TABLE file_import_tabs ADD COLUMN rows_updated INTEGER DEFAULT 0;
ALTER TABLE file_import_tabs ADD COLUMN metrics_inserted INTEGER DEFAULT 0;
