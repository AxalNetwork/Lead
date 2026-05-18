// Task #1: SEC EDGAR cross-reference layer.
//
// Resolves a SEC-emitted name + identifier triple to a `u_entities.id`,
// creating the entity on the fly if no match exists. Identifiers are
// matched in priority order:
//   1. CIK   (most specific — globally unique within SEC)
//   2. CRD   (Form ADV adviser identifier)
//   3. CUSIP (security identifier — implies an issuer entity)
//   4. Ticker (public-market symbol)
//   5. Name + state/jurisdiction (last-resort fuzzy match)
//
// Entity creation routes through the canonical entity write path
// (`createEntity` / `addRole` from src/entities/roles.ts) — never a
// direct INSERT into `u_entities` / `entity_roles`. Identifier facts
// (sec.cik, sec.crd, sec.cusip, sec.ticker) are backfilled via
// `insertFact` so subsequent lookups hit the indexed fact path.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { createEntity as createCanonicalEntity, addRole } from "../../entities/roles";
import type { EntityKind, EntityRole } from "../../entities/model";

export type ResolveKind = EntityKind;

export interface ResolveInput {
  name: string;
  kind: ResolveKind;
  cik?: string | null;
  crd?: string | null;
  cusip?: string | null;
  ticker?: string | null;
  /** State/country jurisdiction, used as a last-resort disambiguator. */
  jurisdiction?: string | null;
  /** Provenance for any identifier facts written during resolution. */
  source: string;
  /** Optional role to attach (e.g. "firm", "fund", "investor"). */
  role?: EntityRole;
}

export interface ResolveResult {
  entity_id: string;
  created: boolean;
  matched_by: "cik" | "crd" | "cusip" | "ticker" | "name+jurisdiction" | "name" | "created";
}

/** Find an entity by a known SEC identifier fact. */
async function findByIdentifier(env: Env, predicate: string, value: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = ? AND value_text = ? AND is_current = 1
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(predicate, value).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

async function findByName(env: Env, name: string, kind: ResolveKind, jurisdiction?: string | null): Promise<string | null> {
  const norm = name.trim().toLowerCase();
  const r = await env.DB.prepare(
    `SELECT e.id FROM u_entities e
       LEFT JOIN entity_summary s ON s.entity_id = e.id
      WHERE e.kind = ?
        AND (lower(e.display_name) = ? OR lower(s.display_name) = ?)
      LIMIT 5`,
  ).bind(kind, norm, norm).all<{ id: string }>();
  const ids = (r.results ?? []).map((row) => row.id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  if (!jurisdiction) return ids[0];
  for (const id of ids) {
    const hit = await env.DB.prepare(
      `SELECT 1 FROM facts
        WHERE entity_id = ? AND is_current = 1
          AND predicate IN ('hq_country_iso2','region','country','sec.cik')
          AND (lower(value_text) = lower(?) OR value_text LIKE ?)
        LIMIT 1`,
    ).bind(id, jurisdiction, `%${jurisdiction}%`).first();
    if (hit) return id;
  }
  return ids[0];
}

/**
 * Resolve a SEC-emitted name + identifier set to an entity_id. Will
 * create the entity if no existing match is found. Writes back any
 * provided identifier facts so future lookups are O(1).
 *
 * Lookup-only mode: pass `createIfMissing: false` to return null
 * instead of creating an entity. Used by the 13F holdings persister
 * to populate `issuer_entity_id` without minting a fresh entity for
 * every CUSIP in a 5000-row holdings table.
 */
export async function resolveSecEntity(env: Env, input: ResolveInput): Promise<ResolveResult>;
export async function resolveSecEntity(env: Env, input: ResolveInput & { createIfMissing: false }): Promise<ResolveResult | null>;
export async function resolveSecEntity(
  env: Env,
  input: ResolveInput & { createIfMissing?: boolean },
): Promise<ResolveResult | null> {
  let matchedBy: ResolveResult["matched_by"] | null = null;
  let entity_id: string | null = null;

  if (input.cik) {
    entity_id = await findByIdentifier(env, "sec.cik", input.cik);
    if (entity_id) matchedBy = "cik";
  }
  if (!entity_id && input.crd) {
    entity_id = await findByIdentifier(env, "sec.crd", input.crd);
    if (entity_id) matchedBy = "crd";
  }
  if (!entity_id && input.cusip) {
    entity_id = await findByIdentifier(env, "sec.cusip", input.cusip);
    if (entity_id) matchedBy = "cusip";
  }
  if (!entity_id && input.ticker) {
    entity_id = await findByIdentifier(env, "sec.ticker", input.ticker);
    if (entity_id) matchedBy = "ticker";
  }
  if (!entity_id && input.name) {
    entity_id = await findByName(env, input.name, input.kind, input.jurisdiction ?? null);
    if (entity_id) matchedBy = input.jurisdiction ? "name+jurisdiction" : "name";
  }

  let created = false;
  if (!entity_id) {
    if (input.createIfMissing === false) return null;
    // Canonical entity create: src/entities/roles.ts. NEVER direct INSERT
    // into u_entities / entity_roles. Side-effects (entity_history,
    // persona match trigger, profile-filler auto-dispatch) are handled
    // by createCanonicalEntity.
    const row = await createCanonicalEntity(env, {
      kind: input.kind,
      display_name: input.name.slice(0, 200),
      // SEC ingest creates many shell entities (CUSIP holdings, etc.);
      // suppress auto profile-fill on org creates so a single 13F doesn't
      // dispatch thousands of profile-filler workflows.
      suppressAutoProfileFill: input.kind === "org",
    });
    entity_id = row.id;
    matchedBy = "created";
    created = true;
  }
  if (input.role) {
    await addRole(env, entity_id, input.role, {
      is_primary: created, source: input.source, confidence: created ? 0.9 : 0.7,
    });
  }

  // Backfill identifier facts so the next lookup hits the index.
  const writeIdent = async (predicate: string, value: string | null | undefined) => {
    if (!value || !entity_id) return;
    await insertFact(env, {
      entity_id,
      predicate,
      value_text: value,
      source_kind: "scrape",
      source: input.source,
      confidence: 0.95,
    }).catch((e) => console.warn("xref writeIdent failed", predicate, (e as Error).message));
  };
  await Promise.all([
    writeIdent("sec.cik", input.cik ?? null),
    writeIdent("sec.crd", input.crd ?? null),
    writeIdent("sec.cusip", input.cusip ?? null),
    writeIdent("sec.ticker", input.ticker ?? null),
  ]);

  return { entity_id, created, matched_by: matchedBy! };
}
