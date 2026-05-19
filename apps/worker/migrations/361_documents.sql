-- Task #13: Document Intelligence (Decks, Models, Legal Docs).
--
-- Migration numbering: spec said 359 but 359 is already
-- 359_cap_tables (Task #5) and 360 is 360_valuation (Task #9).
-- This lands at 361 — the next free slot. Documented as CONSTRAINT,
-- not contract drift.
--
-- Four cooperating tables:
--   1. documents — one row per uploaded blob (R2-backed)
--   2. document_extractions — immutable per extractor_version
--        rows of structured output; re-extraction writes a new row
--   3. document_data_rooms — owner-scoped per-entity rooms
--   4. data_room_documents — many-to-many with auto-category
--
-- All cap-table / SAFE / term-sheet / SHA facts derived from
-- extractions land on the underlying entity via `insertFact`
-- (Task #1 canonical write contract) — that path is handled in
-- services/documents/persist.ts, not at the SQL layer.

CREATE TABLE IF NOT EXISTS documents (
  id                       TEXT PRIMARY KEY,
  owner_email              TEXT NOT NULL,
  target_entity_id         TEXT,                     -- optional: the company/person this doc is about
  filename                 TEXT NOT NULL,
  mime                     TEXT,
  size_bytes               INTEGER NOT NULL DEFAULT 0,
  r2_key                   TEXT NOT NULL,
  sha256                   TEXT,                     -- content addressed
  detected_kind            TEXT,                     -- pitch_deck | financial_model | safe | term_sheet | shareholder_agreement | commercial_contract | nda | unknown
  classifier_confidence    REAL,
  ocr_status               TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | skipped | error
  extraction_status        TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
  extraction_error         TEXT,
  allow_raw_text           INTEGER NOT NULL DEFAULT 0,      -- 0 = redact-before-LLM (default), 1 = send raw
  page_count               INTEGER,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_owner   ON documents(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_target  ON documents(target_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_kind    ON documents(detected_kind);
CREATE INDEX IF NOT EXISTS idx_documents_sha     ON documents(sha256);

-- Append-only. New extractor_version writes a fresh row; the latest
-- row per (document_id, extractor_version) wins for read-time joins.
CREATE TABLE IF NOT EXISTS document_extractions (
  id                       TEXT PRIMARY KEY,
  document_id              TEXT NOT NULL,
  kind                     TEXT NOT NULL,            -- mirrors documents.detected_kind
  extractor_name           TEXT NOT NULL,            -- safeParser, termSheetParser, …
  extractor_version        TEXT NOT NULL,            -- semver of the extractor module
  confidence               REAL NOT NULL DEFAULT 0.5,
  payload_json             TEXT NOT NULL,            -- structured per-kind payload
  redaction_applied        INTEGER NOT NULL DEFAULT 1,
  redaction_counts_json    TEXT,                     -- { email: N, ssn: N, … }
  warnings_json            TEXT,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (document_id, extractor_name, extractor_version)
);
CREATE INDEX IF NOT EXISTS idx_extr_doc          ON document_extractions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extr_kind         ON document_extractions(kind);

CREATE TABLE IF NOT EXISTS document_data_rooms (
  id                       TEXT PRIMARY KEY,
  owner_email              TEXT NOT NULL,
  target_entity_id         TEXT,
  name                     TEXT NOT NULL,
  description              TEXT,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_droom_owner       ON document_data_rooms(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_droom_target      ON document_data_rooms(target_entity_id);

CREATE TABLE IF NOT EXISTS data_room_documents (
  id                       TEXT PRIMARY KEY,
  data_room_id             TEXT NOT NULL,
  document_id              TEXT NOT NULL,
  category                 TEXT NOT NULL,            -- corporate | financial | customer | ip | employment | regulatory | other
  added_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (data_room_id) REFERENCES document_data_rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (data_room_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_drd_room          ON data_room_documents(data_room_id, category);
CREATE INDEX IF NOT EXISTS idx_drd_doc           ON data_room_documents(document_id);
