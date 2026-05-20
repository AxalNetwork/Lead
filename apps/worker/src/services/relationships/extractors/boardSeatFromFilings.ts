// Task #4: board_member_at edges. Primary source is the facts table —
// any predicate ending in `.board_seat` / `.board_member` with a
// value_entity_id pointing at the org. Secondary source: career_history
// rows whose role_title contains "board" or "director" — resolved via
// resolveEntityId. Form 4 / 8-K / ADV tables aren't populated in dev;
// when absent we degrade to the facts/career_history paths cleanly.

import type { Env } from "../../../types";
import type { EdgeProposal, ExtractOpts, ExtractResult } from "../types";
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";

interface FactRow {
  id: string; entity_id: string; predicate: string; value_entity_id: string | null;
  value_text: string | null; evidence_url: string | null; observed_at: string | null;
  source: string | null;
}
interface CareerRow {
  id: string; entity_id: string; organization_entity_id: string | null;
  organization_name: string; role_title: string | null;
  started_at: string | null; ended_at: string | null; source_url: string | null;
}

export const NAME = "boardSeatFromFilings";

export async function extract(env: Env, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const limit = opts.limit ?? 5000;
  const proposals: EdgeProposal[] = [];
  let unresolved = 0, scanned = 0;

  // 1) facts.predicate ~ board_seat/board_member
  {
    const binds: unknown[] = [];
    let where = "(predicate LIKE '%board_seat%' OR predicate LIKE '%board_member%') AND is_current = 1";
    if (opts.entityId) { where += " AND entity_id = ?"; binds.push(opts.entityId); }
    if (opts.since) { where += " AND observed_at >= ?"; binds.push(opts.since); }
    const rows = await safeAll<FactRow>(
      env,
      `SELECT id, entity_id, predicate, value_entity_id, value_text, evidence_url, observed_at, source
         FROM facts WHERE ${where} LIMIT ${limit}`,
      ...binds,
    );
    scanned += rows.length;
    for (const f of rows) {
      let dst = f.value_entity_id;
      if (!dst && f.value_text) dst = await resolveEntityId(env, f.value_text, "org");
      if (!dst) { unresolved += 1; continue; }
      const src = (f.source ?? "").toLowerCase();
      const tag = src.includes("form4") ? "sec.form4" : src.includes("8-k") || src.includes("8k") ? "sec.8k" : src.includes("adv") ? "sec.adv" : "sec.form4";
      proposals.push({
        src_entity_id: f.entity_id, dst_entity_id: dst, kind: "board_member_at",
        source: tag, valid_from: f.observed_at ?? null,
        evidence_url: f.evidence_url ?? null, backing_fact_ids: [f.id],
      });
    }
  }

  // 2) career_history role_title contains 'board' or 'director'
  {
    const binds: unknown[] = [];
    let where = "(LOWER(role_title) LIKE '%board%' OR LOWER(role_title) LIKE '%director%')";
    if (opts.entityId) { where += " AND entity_id = ?"; binds.push(opts.entityId); }
    if (opts.since) { where += " AND COALESCE(updated_at, observed_at) >= ?"; binds.push(opts.since); }
    const rows = await safeAll<CareerRow>(
      env,
      `SELECT id, entity_id, organization_entity_id, organization_name, role_title,
              started_at, ended_at, source_url
         FROM career_history WHERE ${where} LIMIT ${limit}`,
      ...binds,
    );
    scanned += rows.length;
    for (const r of rows) {
      let dst = r.organization_entity_id;
      if (!dst) dst = await resolveEntityId(env, r.organization_name, "org");
      if (!dst) { unresolved += 1; continue; }
      proposals.push({
        src_entity_id: r.entity_id, dst_entity_id: dst, kind: "board_member_at",
        source: "sec.form4", valid_from: r.started_at ?? null, valid_to: r.ended_at ?? null,
        evidence_url: r.source_url ?? null, backing_fact_ids: [],
      });
    }
  }
  return { proposals, unresolved_count: unresolved, scanned };
}
