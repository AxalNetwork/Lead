// Task #3: Cross-border firm-graph linker.
//
// ONLY writer of `legal_structure_graph` (migration 356). All other
// writes (entities, facts, …) stay on the canonical helpers.
//
// One row = one vehicle ↔ canonical-firm binding. A global VC with
// US/Cayman/UK vehicles produces 3 rows pointing at the same
// canonical_firm_entity_id.
//
// Idempotency: UNIQUE(canonical_firm_entity_id, vehicle_entity_id) at
// the DB layer; ON CONFLICT here promotes confidence + refreshes the
// evidence url so re-linking the same pair never duplicates.

import type { Env } from "../../types";
import type { JurisdictionCode } from "../../crawler/adapters/intl/types";

export type VehicleRole =
  | "master" | "feeder" | "parallel" | "adviser"
  | "gp" | "management_company" | "carry_vehicle";

export interface LinkVehicleInput {
  canonical_firm_entity_id: string;
  vehicle_entity_id: string;
  vehicle_role: VehicleRole;
  jurisdiction: JurisdictionCode | null;
  evidence_source_url: string | null;
  confidence?: number;
}

export class FirmGraphError extends Error {
  constructor(msg: string) { super(msg); this.name = "FirmGraphError"; }
}

export async function linkVehicleToCanonicalFirm(env: Env, input: LinkVehicleInput): Promise<void> {
  if (!input.canonical_firm_entity_id || !input.vehicle_entity_id) {
    throw new FirmGraphError("linkVehicleToCanonicalFirm: both entity ids required");
  }
  if (input.canonical_firm_entity_id === input.vehicle_entity_id) {
    throw new FirmGraphError("linkVehicleToCanonicalFirm: vehicle cannot equal canonical firm");
  }
  const confidence = input.confidence ?? 0.7;
  // ON CONFLICT on vehicle_entity_id — the stronger key. Rebinding the
  // same vehicle to a different canonical firm REPLACES the prior
  // canonical, never creates a duplicate row. This is the operational
  // contract for canonical-firm consolidation.
  await env.DB.prepare(
    `INSERT INTO legal_structure_graph
       (id, canonical_firm_entity_id, vehicle_entity_id, vehicle_role,
        jurisdiction, evidence_source_url, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(vehicle_entity_id) DO UPDATE SET
       canonical_firm_entity_id = excluded.canonical_firm_entity_id,
       vehicle_role             = excluded.vehicle_role,
       jurisdiction             = COALESCE(excluded.jurisdiction, legal_structure_graph.jurisdiction),
       evidence_source_url      = COALESCE(excluded.evidence_source_url, legal_structure_graph.evidence_source_url),
       confidence               = MAX(excluded.confidence, legal_structure_graph.confidence)`,
  ).bind(
    crypto.randomUUID(),
    input.canonical_firm_entity_id,
    input.vehicle_entity_id,
    input.vehicle_role,
    input.jurisdiction ?? null,
    input.evidence_source_url,
    confidence,
  ).run();
}

export interface CanonicalFirmGraphRow {
  vehicle_entity_id: string;
  vehicle_role: VehicleRole;
  jurisdiction: string | null;
  evidence_source_url: string | null;
  confidence: number;
}

/** Read all vehicles bound to a canonical firm. Used by the dashboard
 *  to render the "Index Ventures = DE + UK + Cayman + LU" graph card. */
export async function listVehiclesForCanonicalFirm(env: Env, canonicalId: string): Promise<CanonicalFirmGraphRow[]> {
  const r = await env.DB.prepare(
    `SELECT vehicle_entity_id, vehicle_role, jurisdiction, evidence_source_url, confidence
       FROM legal_structure_graph
      WHERE canonical_firm_entity_id = ?
      ORDER BY confidence DESC, vehicle_role ASC`,
  ).bind(canonicalId).all<CanonicalFirmGraphRow>();
  return r.results ?? [];
}

/** Read the canonical-firm binding for a vehicle. Many vehicles map to
 *  exactly one canonical row by construction (UNIQUE pair); a vehicle
 *  re-bound to a different canonical firm replaces, not duplicates. */
export async function lookupCanonicalForVehicle(env: Env, vehicleId: string): Promise<{ canonical_firm_entity_id: string; vehicle_role: VehicleRole } | null> {
  const r = await env.DB.prepare(
    `SELECT canonical_firm_entity_id, vehicle_role
       FROM legal_structure_graph
      WHERE vehicle_entity_id = ?
      ORDER BY confidence DESC LIMIT 1`,
  ).bind(vehicleId).first<{ canonical_firm_entity_id: string; vehicle_role: VehicleRole }>();
  return r ?? null;
}
