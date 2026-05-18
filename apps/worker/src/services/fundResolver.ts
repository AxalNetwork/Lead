// Task #2: Fund-name resolver.
//
// Single canonical entry point used by every LP-disclosure adapter to
// map a free-text fund name (e.g. "Andreessen Horowitz LSV Fund III, L.P.")
// to an existing `u_entities` row of role 'fund'. Match priority:
//   1. Exact normalized-name match against an existing fund entity
//      (and, if a vintage_hint is provided, the vintage corroborates).
//   2. Strong-prefix match (normalized) against fund entity names.
//   3. Substring on the GP firm name + roman/arabic numeral suffix.
//
// When confidence < CREATE_THRESHOLD, mint a new fund entity through the
// canonical `createEntity` path (NEVER a direct INSERT). Identifier
// facts (`fund.name_normalized`, `fund.vintage_year`, `fund.gp_firm`)
// are backfilled via `insertFact` so subsequent lookups hit indexed
// fact rows.
//
// The resolver is intentionally network-free and DB-light: a single
// indexed lookup against `u_entities`, then either a fact-write or a
// canonical createEntity. Adapters call this synchronously per row.

import type { Env } from "../types";
import { insertFact } from "../entities/facts";
import { createEntity, addRole } from "../entities/roles";

const CREATE_THRESHOLD = 0.6; // below this we create a new fund entity

export interface FundResolveInput {
  /** Raw fund name as disclosed. */
  raw: string;
  /** LP entity id — used only as provenance, not for matching. */
  lp_entity_id?: string | null;
  /** Optional vintage year corroboration signal. */
  vintage_hint?: number | null;
  /** Optional GP firm hint (display name) — boosts confidence on match. */
  gp_firm_hint?: string | null;
  /** Provenance for any facts written during resolution. */
  source: string;
  /** Evidence URL stamped on identifier facts. */
  evidence_url?: string | null;
}

export interface FundResolveResult {
  fund_entity_id: string | null;
  gp_firm_entity_id: string | null;
  confidence: number;
  /** True when the fund entity was minted during this call. */
  created: boolean;
  matched_by:
    | "exact_name"
    | "exact_name+vintage"
    | "prefix"
    | "gp+suffix"
    | "created"
    | "unresolved";
}

/**
 * Normalize a fund name for matching:
 *   - lower-case
 *   - strip legal suffixes (L.P., LP, Ltd, Inc, LLC, …)
 *   - collapse roman numerals (II/III/IV) to their arabic form
 *   - drop punctuation, collapse whitespace
 *
 * Exported for tests + the persist layer (so we can dedup raw rows
 * before resolver calls).
 */
export function normalizeFundName(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  // Roman numerals to arabic (order matters — longer first).
  const roman: Array<[RegExp, string]> = [
    [/\bxiii\b/g, "13"], [/\bxii\b/g, "12"], [/\bxi\b/g, "11"],
    [/\bviii\b/g, "8"], [/\bvii\b/g, "7"], [/\bvi\b/g, "6"],
    [/\biv\b/g, "4"], [/\biii\b/g, "3"], [/\bii\b/g, "2"],
    [/\bix\b/g, "9"], [/\bx\b/g, "10"], [/\bv\b/g, "5"], [/\bi\b/g, "1"],
  ];
  for (const [re, n] of roman) s = s.replace(re, n);
  // Drop legal suffixes.
  s = s.replace(
    /\b(l\.?p\.?|llc|l\.?l\.?c\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|gmbh|s\.?a\.?|n\.?v\.?|plc|fund|funds|partners|partnership)\b/g,
    "",
  );
  // Punctuation + multi-space cleanup.
  s = s.replace(/[.,;:'"()/\\&_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

interface FundCandidate {
  entity_id: string;
  display_name: string | null;
  normalized: string | null;
  vintage_year: number | null;
  gp_firm_entity_id: string | null;
}

async function loadFundCandidates(env: Env, normalizedQuery: string): Promise<FundCandidate[]> {
  if (!normalizedQuery) return [];
  // Exact-normalized lookup via the indexed fact path.
  const exact = await env.DB.prepare(
    `SELECT entity_id, value_text FROM facts
      WHERE predicate = 'fund.name_normalized' AND value_text = ? AND is_current = 1
      LIMIT 25`,
  ).bind(normalizedQuery).all<{ entity_id: string; value_text: string }>();
  const ids = new Set<string>((exact.results ?? []).map((r) => r.entity_id));

  // Loose name match. Bounded fan-out; the LIKE only fires when exact
  // missed and is capped to 50 rows so a degenerate query can't blow
  // through the row reader.
  if (ids.size === 0) {
    const loose = await env.DB.prepare(
      `SELECT id, display_name FROM u_entities
        WHERE kind = 'org' AND status = 'active'
          AND lower(display_name) LIKE ?
        LIMIT 50`,
    ).bind(`%${normalizedQuery.slice(0, 40)}%`).all<{ id: string; display_name: string }>();
    for (const r of loose.results ?? []) ids.add(r.id);
  }
  if (ids.size === 0) return [];

  const placeholders = [...ids].map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT e.id, e.display_name,
            (SELECT value_text   FROM facts WHERE entity_id = e.id AND predicate = 'fund.name_normalized' AND is_current = 1 LIMIT 1) AS normalized,
            (SELECT value_number FROM facts WHERE entity_id = e.id AND predicate = 'fund.vintage_year'    AND is_current = 1 LIMIT 1) AS vintage_year,
            (SELECT value_entity_id FROM facts WHERE entity_id = e.id AND predicate = 'fund.gp_firm'      AND is_current = 1 LIMIT 1) AS gp_firm_entity_id
       FROM u_entities e
      WHERE e.id IN (${placeholders})
        AND EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'fund')`,
  ).bind(...ids).all<FundCandidate>();
  return rows.results ?? [];
}

async function findFirmEntityByName(env: Env, name: string): Promise<string | null> {
  const norm = name.trim().toLowerCase();
  if (!norm) return null;
  const r = await env.DB.prepare(
    `SELECT e.id FROM u_entities e
       JOIN entity_roles r ON r.entity_id = e.id AND r.role = 'firm'
      WHERE e.kind = 'org' AND e.status = 'active'
        AND lower(e.display_name) = ?
      LIMIT 1`,
  ).bind(norm).first<{ id: string }>();
  return r?.id ?? null;
}

/**
 * Resolve a raw fund name to a fund entity. Creates a new fund entity
 * (via the canonical createEntity path) when no match clears
 * CREATE_THRESHOLD. Always returns a `fund_entity_id` (or null only on
 * empty input).
 */
export async function resolveFundName(
  env: Env,
  input: FundResolveInput,
): Promise<FundResolveResult> {
  const raw = (input.raw ?? "").trim();
  if (!raw) {
    return {
      fund_entity_id: null, gp_firm_entity_id: null,
      confidence: 0, created: false, matched_by: "unresolved",
    };
  }
  const normalized = normalizeFundName(raw);
  const candidates = await loadFundCandidates(env, normalized);

  let best: { c: FundCandidate; conf: number; matched_by: FundResolveResult["matched_by"] } | null = null;
  for (const c of candidates) {
    const cn = (c.normalized ?? "").trim();
    let conf = 0;
    let matched_by: FundResolveResult["matched_by"] = "prefix";
    if (cn && cn === normalized) {
      conf = 0.85;
      matched_by = "exact_name";
      if (input.vintage_hint && c.vintage_year && Math.abs(c.vintage_year - input.vintage_hint) <= 1) {
        conf = 0.95;
        matched_by = "exact_name+vintage";
      }
    } else if (cn && (cn.startsWith(normalized) || normalized.startsWith(cn))) {
      conf = 0.7;
      matched_by = "prefix";
    } else if (input.gp_firm_hint && c.display_name
               && c.display_name.toLowerCase().includes(input.gp_firm_hint.toLowerCase())) {
      conf = 0.65;
      matched_by = "gp+suffix";
    }
    if (!best || conf > best.conf) best = { c, conf, matched_by };
  }

  if (best && best.conf >= CREATE_THRESHOLD) {
    return {
      fund_entity_id: best.c.entity_id,
      gp_firm_entity_id: best.c.gp_firm_entity_id,
      confidence: best.conf,
      created: false,
      matched_by: best.matched_by,
    };
  }

  // No usable match — mint a new fund entity through the canonical path.
  const row = await createEntity(env, {
    kind: "org",
    display_name: raw.slice(0, 200),
    // No website yet → createEntity's auto profile-fill won't fire.
    suppressAutoProfileFill: true,
  });
  await addRole(env, row.id, "fund", {
    is_primary: true, source: input.source, confidence: 0.7,
  });
  const factCtx = {
    entity_id: row.id,
    source_kind: "scrape" as const,
    source: input.source,
    evidence_url: input.evidence_url ?? null,
    confidence: 0.7,
  };
  await insertFact(env, { ...factCtx, predicate: "fund.name_normalized", value_text: normalized });
  if (input.vintage_hint) {
    await insertFact(env, { ...factCtx, predicate: "fund.vintage_year", value_number: input.vintage_hint });
  }
  let gpFirmEntityId: string | null = null;
  if (input.gp_firm_hint) {
    gpFirmEntityId = await findFirmEntityByName(env, input.gp_firm_hint);
    if (gpFirmEntityId) {
      await insertFact(env, { ...factCtx, predicate: "fund.gp_firm", value_entity_id: gpFirmEntityId, value_text: input.gp_firm_hint });
    }
  }
  return {
    fund_entity_id: row.id,
    gp_firm_entity_id: gpFirmEntityId,
    confidence: 0.5,
    created: true,
    matched_by: "created",
  };
}
