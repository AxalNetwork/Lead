// One place that knows how a sector is actually stored.
//
// Four call sites in the valuation module and one in the edge-quality sweep
// each asked `facts` for `company.sector`, `firm.sector` or `sector`. No
// writer in the worker produces any of those. What is written is:
//
//   * `firm.sectors` / `company.sectors` — a JSON ARRAY in value_json,
//     emitted by the profile workflows (crawler/profileWorkflows/_commonSchemas).
//   * `industry` — value_text, emitted by the account dual-write.
//   * `entity_summary.sectors_csv` — the materialised, deduped, slugged list
//     the summary rebuild derives from `sector` tags.
//
// Reading only the three singular text predicates meant every sector lookup
// returned nothing. In the comp panel that is worse than empty: the screen
// `continue`s past any candidate whose sector does not match, so an operator
// filtering by sector got an empty panel and the reasonable conclusion that
// there were no comparable companies.
//
// These helpers exist so the next reader does not have to rediscover which of
// the six spellings is the live one.

import type { Env } from "../types";

/** Predicates whose value lives in value_text. */
export const SECTOR_TEXT_PREDICATES = [
  "entity.primary_sector", "company.sector", "firm.sector",
  "sector", "industry", "firm.industry",
] as const;

/** Predicates whose value is a JSON array in value_json. */
export const SECTOR_ARRAY_PREDICATES = [
  "firm.sectors", "company.sectors", "sectors",
] as const;

/**
 * True when `entityId` carries `sector` under any storage shape.
 *
 * Written as one statement so a per-row screen costs one round trip. The
 * summary arm uses comma-delimited `instr` — the same technique
 * monitoring/smart.ts uses against the same column — because `sectors_csv`
 * is a bare join of slugs, so a substring test alone would match "fin" inside
 * "fintech".
 */
export async function entityHasSector(env: Env, entityId: string, sector: string): Promise<boolean> {
  const wanted = sector.trim();
  if (!entityId || !wanted) return false;
  const r = await env.DB.prepare(
    `SELECT 1 AS hit FROM entity_summary s
      WHERE s.entity_id = ?
        AND s.sectors_csv IS NOT NULL
        AND instr(',' || lower(s.sectors_csv) || ',', ',' || lower(?) || ',') > 0
      UNION ALL
     SELECT 1 AS hit FROM facts f
      WHERE f.entity_id = ?
        AND f.is_current = 1
        AND (
              (f.predicate IN ('entity.primary_sector','company.sector','firm.sector','sector','industry','firm.industry')
               AND lower(trim(f.value_text)) = lower(?))
           OR (f.predicate IN ('firm.sectors','company.sectors','sectors')
               AND f.value_json IS NOT NULL
               AND EXISTS (SELECT 1 FROM json_each(f.value_json) je
                            WHERE lower(trim(je.value)) = lower(?)))
        )
      LIMIT 1`,
  ).bind(entityId, wanted, entityId, wanted, wanted).first<{ hit: number }>();
  return Boolean(r);
}

/**
 * The entity's primary sector, lower-cased, or null when there is no evidence.
 * Prefers `entity_summary` because it is the materialised list; falls back to
 * facts for entities whose summary has not been rebuilt yet.
 */
export async function entityPrimarySector(env: Env, entityId: string): Promise<string | null> {
  if (!entityId) return null;
  const sum = await env.DB.prepare(
    `SELECT sectors_csv FROM entity_summary WHERE entity_id = ?`,
  ).bind(entityId).first<{ sectors_csv: string | null }>();
  const fromSummary = (sum?.sectors_csv ?? "").split(",").map((x) => x.trim()).find(Boolean);
  if (fromSummary) return fromSummary.toLowerCase();

  const f = await env.DB.prepare(
    `SELECT value_text, value_json FROM facts
      WHERE entity_id = ?
        AND is_current = 1
        AND predicate IN ('entity.primary_sector','company.sector','firm.sector','sector',
                          'industry','firm.industry','firm.sectors','company.sectors','sectors')
      ORDER BY observed_at DESC
      LIMIT 1`,
  ).bind(entityId).first<{ value_text: string | null; value_json: string | null }>();
  const text = f?.value_text?.trim();
  if (text) return text.toLowerCase();
  return firstOfJsonArray(f?.value_json ?? null);
}

/** First non-empty string in a JSON array column, lower-cased; null otherwise. */
export function firstOfJsonArray(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const x of parsed) {
      if (typeof x === "string" && x.trim()) return x.trim().toLowerCase();
    }
  } catch { /* not JSON — nothing to take */ }
  return null;
}

/**
 * `EXISTS (...)` fragment matching a sector against a column already in scope.
 *
 * A literal, not a template: the repo's SQL gate forbids interpolating into a
 * statement, and the only variable part here would have been the column name.
 * Callers that need a different column inline their own copy rather than
 * building one by concatenation.
 *
 * Binds, in order: sector, sector, sector.
 */
export const SECTOR_MATCHES_COMPANY_ENTITY_SQL = `(
  EXISTS (SELECT 1 FROM entity_summary s
           WHERE s.entity_id = vm.company_entity_id
             AND s.sectors_csv IS NOT NULL
             AND instr(',' || lower(s.sectors_csv) || ',', ',' || lower(?) || ',') > 0)
  OR EXISTS (SELECT 1 FROM facts f
              WHERE f.entity_id = vm.company_entity_id
                AND f.is_current = 1
                AND (
                      (f.predicate IN ('entity.primary_sector','company.sector','firm.sector','sector','industry','firm.industry')
                       AND lower(trim(f.value_text)) = lower(?))
                   OR (f.predicate IN ('firm.sectors','company.sectors','sectors')
                       AND f.value_json IS NOT NULL
                       AND EXISTS (SELECT 1 FROM json_each(f.value_json) je
                                    WHERE lower(trim(je.value)) = lower(?)))
                ))
)`;
