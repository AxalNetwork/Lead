-- Task #4: unified entity graph — core u_entities + roles.
--
-- One row per real-world person/firm/company/account. `kind` is the
-- coarse taxonomy bucket; finer-grained semantics live in `entity_roles`
-- so a single person can be both an `investor` and a `founder`, and a
-- single org can be both a `firm` and an `account`.

CREATE TABLE IF NOT EXISTS u_entities (
  id TEXT PRIMARY KEY,                          -- uuid v4
  kind TEXT NOT NULL,                           -- person | org
  display_name TEXT,
  primary_url TEXT,
  primary_domain TEXT,                          -- lowercase apex
  primary_email_key TEXT,                       -- lowercased local + '@' + domain (no '+' suffix)
  primary_linkedin_key TEXT,                    -- canonical /in/<slug> or /company/<slug>
  primary_twitter_handle TEXT,                  -- lowercased, no '@'
  primary_github_handle TEXT,                   -- lowercased
  quality_score REAL NOT NULL DEFAULT 0,        -- 0..100 (rebuilt from facts coverage + confidence)
  status TEXT NOT NULL DEFAULT 'active',        -- active | merged | soft_deleted | dnc
  merged_into_entity_id TEXT,                   -- non-null implies status='merged'
  last_synced_vec_at TEXT,
  last_synced_search_at TEXT,
  last_summary_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON u_entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_status ON u_entities(status);
CREATE INDEX IF NOT EXISTS idx_entities_primary_domain ON u_entities(primary_domain) WHERE primary_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_primary_email_key ON u_entities(primary_email_key) WHERE primary_email_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_primary_linkedin_key ON u_entities(primary_linkedin_key) WHERE primary_linkedin_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON u_entities(merged_into_entity_id) WHERE merged_into_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_quality ON u_entities(quality_score DESC);

-- Multi-role per entity. Enum enforced at the application layer.
-- role ∈ {investor, founder, operator, executive, board_member,
--        advisor, employee, customer, prospect, buyer, partner,
--        firm, fund, accelerator, company, account, school}
CREATE TABLE IF NOT EXISTS entity_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_entity_roles_entity ON entity_roles(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_roles_role ON entity_roles(role);

-- Cross-ref legacy ids → unified entity so dual-write can find the row
-- on the second pass without re-running the dedup search. Per legacy
-- table+id pair, at most one entity.
CREATE TABLE IF NOT EXISTS entity_legacy_map (
  legacy_table TEXT NOT NULL,                   -- 'firms' | 'leads' | 'companies' | 'accounts' | 'buyers'
  legacy_id TEXT NOT NULL,                      -- stringified (firms/companies are INTEGER)
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(legacy_table, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_legacy_map_entity ON entity_legacy_map(entity_id);
