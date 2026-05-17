-- Task #3: Conversational research agent.
--
-- Three tables back the agent:
--   * agent_sessions   — one row per chat thread, owned by an Access email.
--   * agent_messages   — append-only event log; one row per user/assistant/
--                        tool/system event the loop emits. Streams persist
--                        live so a refresh recovers the full conversation.
--   * saved_research   — snapshot of a question + the latest answer for
--                        nightly diff refresh.
--
-- All tables filter on owner_email derived from the Access JWT — no
-- cross-tenant reads. Applied automatically by the existing CI
-- `wrangler d1 migrations apply DB --remote` step.

CREATE TABLE IF NOT EXISTS agent_sessions (
  id              TEXT PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT 'New research',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner ON agent_sessions(owner_email, last_message_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  owner_email      TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content          TEXT,
  tool_name        TEXT,
  tool_call_json   TEXT,
  tool_result_json TEXT,
  citations_json   TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_owner_day ON agent_messages(owner_email, created_at);

CREATE TABLE IF NOT EXISTS saved_research (
  id                  TEXT PRIMARY KEY,
  owner_email         TEXT NOT NULL,
  title               TEXT NOT NULL,
  question            TEXT NOT NULL,
  answer_markdown     TEXT NOT NULL,
  citations_json      TEXT,
  pinned_entity_ids_json TEXT,
  diff_json           TEXT,
  session_id          TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_refreshed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_saved_research_owner ON saved_research(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_research_refresh ON saved_research(last_refreshed_at);
