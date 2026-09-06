// Task #5 step 3: career & education enrichers.
//
// Real-data path: read from `facts` (predicates emitted by OSINT, scrapers,
// the Crunchbase/LinkedIn dispatcher) + `identity_handles`. Output flows
// through the discriminated `StructuredWrite` union; no SQL writes here.
//
// External-API path (LinkedIn / Crunchbase / AngelList / SEC EDGAR /
// Companies House / ProQuest / Google Scholar) is a no-op when the
// corresponding env key is absent — see `estCostUsd`.

import type { Env } from "../../../types";
import { type Enricher, type EnricherResult, type StructuredWrite } from "../types";

interface FactRow {
  predicate: string;
  value_text: string | null;
  value_number: number | null;
  value_json: string | null;
  evidence_url: string | null;
  observed_at: string;
}

async function loadFactsByPredicates(
  env: Env, entityId: string, prefixes: string[],
): Promise<FactRow[]> {
  if (!prefixes.length) return [];
  const where = prefixes.map(() => "predicate LIKE ?").join(" OR ");
  const binds = prefixes.map((p) => `${p}%`);
  try {
    const r = await env.DB.prepare(
      `SELECT predicate, value_text, value_number, value_json, evidence_url, observed_at
         FROM facts WHERE entity_id = ? AND (${where})
         ORDER BY observed_at DESC LIMIT 200`,
    ).bind(entityId, ...binds).all<FactRow>();
    return r.results ?? [];
  } catch { return []; }
}

function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// =========================================================================
// careerProfiler — promotes person.role / person.employment / person.career
// facts (and OSINT-discovered LinkedIn current-role) into structured
// career_history rows.
// =========================================================================
export const careerProfiler: Enricher = {
  name: "careerProfiler",
  category: "career",
  respectsPrivacy: false,        // employment history is public-record signal
  estCostUsd: (_env) => {
    // Task #5: paid LinkedIn/Crunchbase enrichment APIs were removed.
    // Career history is now derived from in-house-scraped facts only,
    // so this enricher carries no per-call USD cost.
    return 0;
  },
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await loadFactsByPredicates(env, entityId, [
      "person.career", "person.employment", "person.role",
    ]);
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      const v = safeJsonParse<Record<string, unknown>>(f.value_json) ?? {};
      // `employer` / `employer_entity_id` is the shape services/secEdgar/
      // persist.ts writes for Form ADV control persons, Form D related
      // persons and 10-K executives — SEC EDGAR being the only free live
      // source of person.career facts. Reading only the profile.ts shape
      // made every one of them invisible to this enricher, so none ever
      // became a career_history row.
      const orgName = (v.organization_name as string)
        ?? (v.employer as string)
        ?? (v.org as string) ?? (v.company as string) ?? (f.value_text ?? "");
      if (!orgName) continue;
      const orgEntityId = (v.organization_entity_id as string)
        ?? (v.employer_entity_id as string) ?? null;
      const startedAt = (v.started_at as string) ?? (v.start_date as string) ?? null;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      const dedupe = `${orgName}|${startedAt ?? ""}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      writes.push({
        kind: "career",
        input: {
          entityId,
          organizationName: String(orgName).slice(0, 200),
          organizationEntityId: orgEntityId,
          roleTitle: (v.role_title as string) ?? (v.title as string) ?? null,
          seniority: (v.seniority as string) ?? null,
          department: (v.department as string) ?? null,
          startedAt,
          endedAt: (v.ended_at as string) ?? null,
          isCurrent: v.is_current === true,
          summary: (v.summary as string) ?? null,
          sourceUrl,
          confidence: typeof v.confidence === "number" ? (v.confidence as number) : 0.7,
        },
      });
    }
    return {
      writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 },
    };
  },
};

// =========================================================================
// boardSeatProfiler — SEC EDGAR + Companies House surface board memberships.
// Reads `person.board_seat*` facts; no-ops when no signal exists.
//
// Two payload shapes reach this enricher and only one used to be handled,
// which left the whole board-seat chain dead:
//
//   { organization_name, role, started_at, … }   entities/profile.ts (mirror)
//   ["Acme Corp", "Beta Inc"]                    crawler/profileWorkflows/
//                                                investor_person.ts, which
//                                                writes `person.board_seats`
//                                                (plural) as a bare array of
//                                                company names
//
// The predicate difference is not the problem — loadFactsByPredicates matches
// on a LIKE prefix, so the plural was always selected. The array was: parsing
// it as an object left organization_name undefined and every row was skipped,
// so board_seats never got a row, `person.board_seat` facts were never
// mirrored, and signalBoardOverlap had nothing to join on.
// =========================================================================

/** Board-seat payloads normalised to the object shape addBoardSeat wants. */
function boardSeatEntries(valueJson: string | null): Record<string, unknown>[] {
  const parsed = safeJsonParse<unknown>(valueJson);
  if (!parsed) return [];
  // The bare-array shape carries a name and nothing else — no role, no dates,
  // no resolved org id. That is still enough for a board_seats row and for
  // the overlap signal, which is why it is worth promoting rather than
  // discarding.
  if (Array.isArray(parsed)) {
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((name) => ({ organization_name: name.trim() }));
  }
  if (typeof parsed === "object") return [parsed as Record<string, unknown>];
  return [];
}

export const boardSeatProfiler: Enricher = {
  name: "boardSeatProfiler",
  category: "career",
  respectsPrivacy: false,
  estCostUsd: () => 0, // SEC EDGAR + UK Companies House both free
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await loadFactsByPredicates(env, entityId, ["person.board_seat"]);
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      for (const v of boardSeatEntries(f.value_json)) {
        const orgName = (v.organization_name as string) ?? "";
        if (!orgName) continue;
        const startedAt = (v.started_at as string) ?? null;
        const key = `${orgName}|${startedAt ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceUrl = f.evidence_url || (v.source_url as string) || "";
        if (!sourceUrl) continue;
        writes.push({
          kind: "board_seat",
          input: {
            entityId, organizationName: orgName,
            organizationEntityId: (v.organization_entity_id as string) ?? null,
            role: (v.role as string) ?? null,
            isIndependent: v.is_independent === true,
            committee: (v.committee as string) ?? null,
            startedAt, endedAt: (v.ended_at as string) ?? null,
            sourceUrl,
            confidence: 0.75,
          },
        });
      }
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// educationProfiler — LinkedIn / alumni directories / Google Scholar.
// Reads `person.education` facts; no-ops when none.
// =========================================================================
export const educationProfiler: Enricher = {
  name: "educationProfiler",
  category: "education",
  respectsPrivacy: false,
  estCostUsd: () => 0, // alumni directories + Scholar free; LinkedIn covered by careerProfiler
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await loadFactsByPredicates(env, entityId, ["person.education"]);
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      const v = safeJsonParse<Record<string, unknown>>(f.value_json) ?? {};
      const institution = (v.institution as string) ?? (v.school as string) ?? "";
      if (!institution) continue;
      const degree = (v.degree as string) ?? null;
      const endedYear = typeof v.ended_year === "number" ? (v.ended_year as number) : null;
      const key = `${institution}|${degree ?? ""}|${endedYear ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "education",
        input: {
          entityId, institution, degree,
          field: (v.field as string) ?? null,
          startedYear: typeof v.started_year === "number" ? (v.started_year as number) : null,
          endedYear, honors: (v.honors as string) ?? null,
          sourceUrl, confidence: 0.75,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const careerCategoryEnrichers: Enricher[] = [careerProfiler, boardSeatProfiler, educationProfiler];
