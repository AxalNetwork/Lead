-- Task #4: compatibility views. Existing routes read from `firms` /
-- `leads` / `companies` / `accounts` / `buyers` directly; these views
-- expose the same shapes but exclude rows whose mapped entity has been
-- merged or soft-deleted. Phase 2 will switch readers to `v_*`.
--
-- Implementation: LEFT JOIN against `entity_legacy_map`+`u_entities` so
-- rows not yet mapped (backfill in progress, dual-write disabled) still
-- show up.

CREATE VIEW IF NOT EXISTS v_firms AS
SELECT f.*
FROM firms f
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'firms' AND elm.legacy_id = CAST(f.id AS TEXT)
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');

CREATE VIEW IF NOT EXISTS v_leads AS
SELECT l.*
FROM leads l
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'leads' AND elm.legacy_id = l.id
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');

CREATE VIEW IF NOT EXISTS v_companies AS
SELECT c.*
FROM companies c
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'companies' AND elm.legacy_id = CAST(c.id AS TEXT)
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');

CREATE VIEW IF NOT EXISTS v_accounts AS
SELECT a.*
FROM accounts a
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'accounts' AND elm.legacy_id = a.id
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');

CREATE VIEW IF NOT EXISTS v_buyers AS
SELECT b.*
FROM buyers b
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'buyers' AND elm.legacy_id = b.id
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');

CREATE VIEW IF NOT EXISTS v_firm_people AS
SELECT fp.*
FROM firm_people fp
LEFT JOIN entity_legacy_map elm_f
  ON elm_f.legacy_table = 'firms' AND elm_f.legacy_id = CAST(fp.firm_id AS TEXT)
LEFT JOIN u_entities ef ON ef.id = elm_f.entity_id
LEFT JOIN entity_legacy_map elm_l
  ON elm_l.legacy_table = 'leads' AND elm_l.legacy_id = fp.lead_id
LEFT JOIN u_entities el ON el.id = elm_l.entity_id
WHERE (ef.id IS NULL OR ef.status NOT IN ('merged', 'soft_deleted'))
  AND (el.id IS NULL OR el.status NOT IN ('merged', 'soft_deleted'));

CREATE VIEW IF NOT EXISTS v_firm_portfolio AS
SELECT fp.*
FROM firm_portfolio fp
LEFT JOIN entity_legacy_map elm
  ON elm.legacy_table = 'firms' AND elm.legacy_id = CAST(fp.firm_id AS TEXT)
LEFT JOIN u_entities e
  ON e.id = elm.entity_id
WHERE e.id IS NULL OR e.status NOT IN ('merged', 'soft_deleted');
