// Task #1: SEC EDGAR cross-reference layer.
//
// Resolves a SEC-emitted name + identifier triple to a `u_entities.id`,
// creating the entity row on the fly if no match exists. Identifiers
// are matched in priority order:
//   1. CIK   (most specific — globally unique within SEC)
//   2. CRD   (Form ADV adviser identifier)
//   3. CUSIP (security identifier — implies an issuer entity)
//   4. Name + state/jurisdiction (last-resort fuzzy match)
//
// Identifier facts (sec.cik, sec.crd, sec.cusip) are written through
// `insertFact` so downstream lookup uses the same canonical store the
// rest of the entity layer reads from.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";

export type ResolveKind = "person" | "org";

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
  role?: string;
}

export interface ResolveResult {
  entity_id: string;
  created: boolean;
  matched_by: "cik" | "crd" | "cusip" | "ticker" | "name+jurisdiction" | "name" | "created";
}

const SLUG_RE = /[^a-z0-9]+/g;

function slugifyName(s: string): string {
  return s.toLowerCase().replace(SLUG_RE, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/**
 * Find an entity that already has the given identifier fact.
 * Returns the entity_id or null.
 */
async function findByIdentifier(env: Env, predicate: string, value: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = ? AND value_text = ? AND is_current = 1
      ORDER BY observed_at DESC LIMIT 1`,
  ).bind(predicate, value).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

async function findByName(env: Env, name: string, kind: ResolveKind, jurisdiction?: string | null): Promise<string | null> {
  // Exact display_name match scoped to kind. Then optionally narrow by
  // a jurisdiction fact (state or country) to disambiguate common names.
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
  // Try to narrow by hq_country_iso2 / hq_city / region facts.
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

async function createEntity(env: Env, name: string, kind: ResolveKind, role?: string): Promise<string> {
  const id = crypto.randomUUID();
  const slug = `${slugifyName(name)}-${id.slice(0, 6)}`;
  await env.DB.prepare(
    `INSERT INTO u_entities (id, kind, display_name, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(id, kind, name.slice(0, 200), slug).run();
  if (role) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, confidence)
       VALUES (?, ?, 1, 0.9)`,
    ).bind(id, role).run();
  }
  return id;
}

/**
 * Resolve a SEC-emitted name + identifier set to an entity_id. Will
 * create the entity if no existing match is found. Writes back any
 * provided identifier facts so future lookups are O(1).
 */
export async function resolveSecEntity(env: Env, input: ResolveInput): Promise<ResolveResult> {
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
    entity_id = await createEntity(env, input.name, input.kind, input.role);
    matchedBy = "created";
    created = true;
  } else if (input.role) {
    // Make sure the role is attached, even on existing entities.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, confidence)
       VALUES (?, ?, 0, 0.7)`,
    ).bind(entity_id, input.role).run();
  }

  // Backfill identifier facts so the next lookup hits the index.
  const writeIdent = async (predicate: string, value: string | null | undefined) => {
    if (!value) return;
    await insertFact(env, {
      entity_id: entity_id!,
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

  return { entity_id: entity_id!, created, matched_by: matchedBy! };
}
