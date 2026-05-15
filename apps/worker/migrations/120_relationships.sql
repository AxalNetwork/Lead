-- Task #21: relationship graph schema.
-- The spec calls this 110_relationships.sql, but 110 is already taken by
-- 110_firms_ui.sql; using 120 to keep migrations strictly monotonically
-- ordered. Logical naming and content match spec exactly.

-- Universal entity row. ref_table indicates which source table the entity
-- mirrors (`leads`, `firms`, `companies`, or `users` for the caller's own
-- profile auto-created on first /intros call).
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- person | firm | company | school | user
  ref_table TEXT,                     -- leads | firms | companies | users | NULL
  ref_id TEXT,                        -- pk of source row (text to fit lead UUIDs)
  name TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_ref ON entities(ref_table, ref_id);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

-- Edges. The src/dst pair plus kind+source uniquely identifies a fact so
-- the derivation job can re-run safely (INSERT OR REPLACE).
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- works_at | was_at | partner_at | founded |
                                      -- invested_in | led_round_in | co_invested_with |
                                      -- board_of | school_with | colleague_of |
                                      -- family_of | referred | mentions
  source TEXT NOT NULL,               -- e.g. derive:firm_people | manual | parser:co
  strength REAL NOT NULL DEFAULT 1.0,
  started_at TEXT,
  ended_at TEXT,
  evidence_url TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relationships(src, dst, kind, source);
CREATE INDEX IF NOT EXISTS idx_rel_src ON relationships(src, kind);
CREATE INDEX IF NOT EXISTS idx_rel_dst ON relationships(dst, kind);
CREATE INDEX IF NOT EXISTS idx_rel_kind ON relationships(kind);
