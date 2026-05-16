-- Task #4: normalized channels. Replaces leads.email/phone/linkedin_url,
-- buyers.email/linkedin_url/twitter_url, firms.contact_email, etc. by
-- collapsing every contact identifier into one indexed table keyed by
-- (kind, canonical). Reverse lookup ("who has this email?") is one
-- indexed hit.

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,                          -- uuid v4
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- email | phone | linkedin | twitter | github | website | other
  canonical TEXT NOT NULL,                      -- lowercased email key / E.164 / canonical URL
  display TEXT,                                 -- original presentation form
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 0,
  is_dnc INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, kind, canonical)
);

CREATE INDEX IF NOT EXISTS idx_channels_kind_canonical ON channels(kind, canonical);
CREATE INDEX IF NOT EXISTS idx_channels_entity ON channels(entity_id);
CREATE INDEX IF NOT EXISTS idx_channels_primary ON channels(entity_id, kind, is_primary) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_channels_dnc ON channels(canonical) WHERE is_dnc = 1;
