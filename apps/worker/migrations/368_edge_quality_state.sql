-- Task #3 (follow-up): resumable cursor for edge-quality rescoring.
--
-- The nightly sweep rescores rel_edges in id-ASC order, bounded at
-- 5000 edges/tick (Task #2 fund-return precedent). On graphs larger
-- than that ceiling a single tick would otherwise re-process the
-- same lowest-id edges every night while the tail starves. This
-- one-row state table persists the last processed edge id so the
-- next tick resumes where the previous one stopped, wrapping back
-- to the start when the tail is reached.
--
-- The same table also records last_full_pass_at (timestamp of the
-- most recent wrap) so operators can verify the freshness guarantee
-- (every edge re-scored within ⌈total_edges / 5000⌉ days).

CREATE TABLE IF NOT EXISTS edge_quality_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT NOT NULL DEFAULT '',
  last_full_pass_at TEXT,
  edges_scored_cum INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO edge_quality_state (id, cursor) VALUES (1, '');
