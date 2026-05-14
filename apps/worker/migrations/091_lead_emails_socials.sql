-- Task #17: structured emails_json + socials_json columns on leads.
-- Each entry is a JSON object so we keep verification state and provenance,
-- not just raw strings. Append-only union semantics on merge.
--
-- emails_json schema (per entry):
--   { "email": "...", "verified": 0|1, "source": "...",
--     "source_url": "...", "observed_at": "ISO-8601" }
--
-- socials_json schema (per entry):
--   { "platform": "linkedin"|"twitter"|"crunchbase"|"...",
--     "url": "...", "source": "...",
--     "source_url": "...", "observed_at": "ISO-8601" }

ALTER TABLE leads ADD COLUMN emails_json TEXT;
ALTER TABLE leads ADD COLUMN socials_json TEXT;
