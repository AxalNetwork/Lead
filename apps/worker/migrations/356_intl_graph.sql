-- Task #3: International Coverage Pack.
--
-- Operational ledger of the cross-border firm-graph linker. The only
-- new table this task introduces: every other write (entities, facts,
-- deals, funds, lp commitments) routes through the canonical helpers
-- per replit.md.
--
-- One row binds a vehicle entity to its canonical firm. A global VC
-- with Delaware adviser + Cayman master + Luxembourg parallel + UK
-- adviser shows up as 4 rows pointing at one `canonical_firm_entity_id`.
--
-- Migration slot 356: spec's proposed 349 was already taken by the SEC
-- EDGAR task (349_sec_edgar.sql); 355 reserved for an in-flight task.

CREATE TABLE IF NOT EXISTS legal_structure_graph (
  id                        TEXT PRIMARY KEY,
  canonical_firm_entity_id  TEXT NOT NULL REFERENCES u_entities(id) ON DELETE CASCADE,
  vehicle_entity_id         TEXT NOT NULL REFERENCES u_entities(id) ON DELETE CASCADE,
  vehicle_role              TEXT NOT NULL CHECK (vehicle_role IN
    ('master','feeder','parallel','adviser','gp','management_company','carry_vehicle')),
  jurisdiction              TEXT,                 -- ISO2 or 'EU'
  evidence_source_url       TEXT,
  confidence                REAL NOT NULL DEFAULT 0.7,
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A vehicle can only belong to ONE canonical firm at a time.
  -- UNIQUE(vehicle_entity_id) enforces canonical-binding consistency;
  -- the (canonical, vehicle) pair UNIQUE is implied by the per-vehicle
  -- one — kept here explicitly to make the spec contract visible.
  UNIQUE(vehicle_entity_id),
  UNIQUE(canonical_firm_entity_id, vehicle_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_lsg_canonical ON legal_structure_graph(canonical_firm_entity_id);
CREATE INDEX IF NOT EXISTS idx_lsg_vehicle   ON legal_structure_graph(vehicle_entity_id);
