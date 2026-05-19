// Reference-network builder — emits reference_candidates rows from six
// discovery passes:
//   1. co-founders of prior startups (shared 'founded'/'person.career_entry' rows
//      at the same company in the same founding window)
//   2. first-5 employees of prior startups (career_history rows at the same
//      company within ±18 months of founding)
//   3. board peers (board_seats rows at the same org with overlapping tenure)
//   4. co-authors on publications (publication_authors table)
//   5. co-panelists at conferences (conference_attendees table)
//   6. same-batch accelerator alumni (accelerator_batches table)
//
// All optional source tables are wrapped in try/catch so the builder
// gracefully degrades when a particular source isn't populated yet.

import type { Env } from "../../types";
import { overlapMonths, sha256Hex } from "./util";

/**
 * Compute a stable hash over the source rows that feed the reference
 * graph for an entity. Used by the nightly sweep to detect graph-only
 * changes (a new publication, new board seat, new accelerator-batch
 * peer) without requiring the profile to be viewed first.
 *
 * Each optional source is wrapped in try/catch so missing tables in
 * test DBs degrade to "no contribution" instead of throwing.
 */
export async function computeReferenceGraphHash(env: Env, entityId: string): Promise<string> {
  const parts: string[] = [];
  const push = async (label: string, sql: string) => {
    try {
      const r = await env.DB.prepare(sql).bind(entityId).all<Record<string, unknown>>();
      const rows = (r.results ?? []).map((x) => JSON.stringify(x)).sort();
      parts.push(`${label}:${rows.join("|")}`);
    } catch { parts.push(`${label}:_missing`); }
  };
  await push("career", `SELECT organization_entity_id, organization_name, started_at, ended_at, role_title FROM career_history WHERE entity_id = ?`);
  await push("board",  `SELECT organization_entity_id, organization_name, started_at, ended_at FROM board_seats WHERE entity_id = ?`);
  await push("pubs",   `SELECT publication_id FROM publication_authors WHERE entity_id = ?`);
  await push("conf",   `SELECT conference_id FROM conference_attendees WHERE entity_id = ?`);
  await push("accel",  `SELECT accelerator, batch FROM accelerator_batches WHERE entity_id = ?`);
  return sha256Hex(parts.join("\n"));
}

const BUILDER_VERSION = "0.1.0";

export interface BuildSummary {
  subject_entity_id: string;
  by_kind: Record<string, number>;
  total: number;
}

interface Candidate {
  ref_entity_id?: string | null;
  ref_display_name: string;
  relationship_kind: string;
  shared_context?: string | null;
  time_overlap_months?: number | null;
  confidence: number;
  reasoning: string;
  evidence_url?: string | null;
}

async function upsertCandidate(env: Env, subjectId: string, c: Candidate): Promise<boolean> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO reference_candidates
        (id, subject_entity_id, ref_entity_id, ref_display_name, relationship_kind,
         shared_context, time_overlap_months, confidence, reasoning, evidence_url, builder_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_entity_id, ref_display_name, relationship_kind, shared_context)
       DO UPDATE SET
         ref_entity_id = excluded.ref_entity_id,
         time_overlap_months = excluded.time_overlap_months,
         confidence = excluded.confidence,
         reasoning = excluded.reasoning,
         evidence_url = excluded.evidence_url,
         builder_version = excluded.builder_version,
         refreshed_at = datetime('now')`,
    ).bind(
      id, subjectId, c.ref_entity_id ?? null, c.ref_display_name, c.relationship_kind,
      c.shared_context ?? "", c.time_overlap_months ?? null, c.confidence,
      c.reasoning, c.evidence_url ?? null, BUILDER_VERSION,
    ).run();
    return true;
  } catch (e) {
    console.warn("reference_candidate upsert failed", (e as Error).message);
    return false;
  }
}

export async function buildReferenceCandidates(env: Env, subjectEntityId: string): Promise<BuildSummary> {
  const summary: BuildSummary = { subject_entity_id: subjectEntityId, by_kind: {}, total: 0 };
  const bump = (k: string) => { summary.by_kind[k] = (summary.by_kind[k] ?? 0) + 1; summary.total += 1; };

  // Subject's prior orgs from career_history.
  let subjectCareer: Array<{ org_id: string | null; org_name: string; started_at: string | null; ended_at: string | null }> = [];
  try {
    const r = await env.DB.prepare(
      `SELECT organization_entity_id AS org_id, organization_name AS org_name, started_at, ended_at
         FROM career_history WHERE entity_id = ?`,
    ).bind(subjectEntityId).all<{ org_id: string | null; org_name: string; started_at: string | null; ended_at: string | null }>();
    subjectCareer = r.results ?? [];
  } catch { /* */ }

  // Pass 1 + 2: co-founders / early employees at prior orgs.
  for (const stint of subjectCareer) {
    try {
      const peers = await env.DB.prepare(
        `SELECT ch.entity_id AS pid, u.display_name AS pname, ch.started_at, ch.ended_at, ch.role_title
           FROM career_history ch
           LEFT JOIN u_entities u ON u.id = ch.entity_id
          WHERE (ch.organization_entity_id = ? OR ch.organization_name = ?)
            AND ch.entity_id != ?
          LIMIT 50`,
      ).bind(stint.org_id ?? "", stint.org_name, subjectEntityId)
       .all<{ pid: string; pname: string | null; started_at: string | null; ended_at: string | null; role_title: string | null }>();
      for (const peer of peers.results ?? []) {
        const overlap = overlapMonths(stint.started_at, stint.ended_at, peer.started_at, peer.ended_at);
        if (overlap == null || overlap < 1) continue;
        const isCofounder = /founder|co-?founder/i.test(peer.role_title ?? "");
        const kind = isCofounder ? "co_founder" : "early_employee";
        const ok = await upsertCandidate(env, subjectEntityId, {
          ref_entity_id: peer.pid,
          ref_display_name: peer.pname ?? "Unknown",
          relationship_kind: kind,
          shared_context: stint.org_name,
          time_overlap_months: overlap,
          confidence: isCofounder ? 0.9 : 0.7,
          reasoning: `${isCofounder ? "Co-founders" : "Overlapped"} at ${stint.org_name} for ${overlap} months.`,
        });
        if (ok) bump(kind);
      }
    } catch { /* */ }
  }

  // Pass 3: board peers.
  try {
    const subjBoard = await env.DB.prepare(
      `SELECT organization_entity_id AS org_id, organization_name AS org_name, started_at, ended_at
         FROM board_seats WHERE entity_id = ?`,
    ).bind(subjectEntityId).all<{ org_id: string | null; org_name: string; started_at: string | null; ended_at: string | null }>();
    for (const seat of subjBoard.results ?? []) {
      const peers = await env.DB.prepare(
        `SELECT bs.entity_id AS pid, u.display_name AS pname, bs.started_at, bs.ended_at
           FROM board_seats bs
           LEFT JOIN u_entities u ON u.id = bs.entity_id
          WHERE (bs.organization_entity_id = ? OR bs.organization_name = ?)
            AND bs.entity_id != ?
          LIMIT 50`,
      ).bind(seat.org_id ?? "", seat.org_name, subjectEntityId)
       .all<{ pid: string; pname: string | null; started_at: string | null; ended_at: string | null }>();
      for (const peer of peers.results ?? []) {
        const overlap = overlapMonths(seat.started_at, seat.ended_at, peer.started_at, peer.ended_at);
        if (overlap == null || overlap < 1) continue;
        const ok = await upsertCandidate(env, subjectEntityId, {
          ref_entity_id: peer.pid,
          ref_display_name: peer.pname ?? "Unknown",
          relationship_kind: "board_peer",
          shared_context: seat.org_name,
          time_overlap_months: overlap,
          confidence: 0.85,
          reasoning: `Board peers at ${seat.org_name} for ${overlap} months.`,
        });
        if (ok) bump("board_peer");
      }
    }
  } catch { /* */ }

  // Pass 4: co-authors.
  try {
    const r = await env.DB.prepare(
      `SELECT a2.entity_id AS pid, u.display_name AS pname, a1.publication_title AS title, a1.published_at AS published_at
         FROM publication_authors a1
         JOIN publication_authors a2 ON a1.publication_id = a2.publication_id AND a2.entity_id != a1.entity_id
         LEFT JOIN u_entities u ON u.id = a2.entity_id
        WHERE a1.entity_id = ?
        LIMIT 100`,
    ).bind(subjectEntityId).all<{ pid: string; pname: string | null; title: string | null; published_at: string | null }>();
    for (const row of r.results ?? []) {
      const ok = await upsertCandidate(env, subjectEntityId, {
        ref_entity_id: row.pid,
        ref_display_name: row.pname ?? "Unknown",
        relationship_kind: "co_author",
        shared_context: row.title ?? "Joint publication",
        confidence: 0.8,
        reasoning: `Co-authors on "${row.title ?? "publication"}"${row.published_at ? ` (${row.published_at})` : ""}.`,
      });
      if (ok) bump("co_author");
    }
  } catch { /* */ }

  // Pass 5: co-panelists.
  try {
    const r = await env.DB.prepare(
      `SELECT a2.entity_id AS pid, u.display_name AS pname, a1.conference_name AS conf, a1.year AS year
         FROM conference_attendees a1
         JOIN conference_attendees a2 ON a1.conference_id = a2.conference_id AND a2.entity_id != a1.entity_id
         LEFT JOIN u_entities u ON u.id = a2.entity_id
        WHERE a1.entity_id = ?
        LIMIT 100`,
    ).bind(subjectEntityId).all<{ pid: string; pname: string | null; conf: string | null; year: number | null }>();
    for (const row of r.results ?? []) {
      const ok = await upsertCandidate(env, subjectEntityId, {
        ref_entity_id: row.pid,
        ref_display_name: row.pname ?? "Unknown",
        relationship_kind: "co_panelist",
        shared_context: `${row.conf ?? "Conference"}${row.year ? ` ${row.year}` : ""}`,
        confidence: 0.6,
        reasoning: `Co-attended ${row.conf ?? "the conference"}${row.year ? ` in ${row.year}` : ""}.`,
      });
      if (ok) bump("co_panelist");
    }
  } catch { /* */ }

  // Pass 6: same-batch accelerator alumni.
  try {
    const r = await env.DB.prepare(
      `SELECT b2.entity_id AS pid, u.display_name AS pname, b1.accelerator AS acc, b1.batch AS batch
         FROM accelerator_batches b1
         JOIN accelerator_batches b2
           ON b1.accelerator = b2.accelerator AND b1.batch = b2.batch AND b2.entity_id != b1.entity_id
         LEFT JOIN u_entities u ON u.id = b2.entity_id
        WHERE b1.entity_id = ?
        LIMIT 100`,
    ).bind(subjectEntityId).all<{ pid: string; pname: string | null; acc: string | null; batch: string | null }>();
    for (const row of r.results ?? []) {
      const ok = await upsertCandidate(env, subjectEntityId, {
        ref_entity_id: row.pid,
        ref_display_name: row.pname ?? "Unknown",
        relationship_kind: "batch_cohort",
        shared_context: `${row.acc ?? "Accelerator"} ${row.batch ?? ""}`.trim(),
        confidence: 0.7,
        reasoning: `Same-batch alumni at ${row.acc ?? "accelerator"} (${row.batch ?? "?"}).`,
      });
      if (ok) bump("batch_cohort");
    }
  } catch { /* */ }

  // Persist the reference-graph hash so the nightly sweep can detect
  // graph-only changes and trigger rebuilds without a profile view.
  try {
    const hash = await computeReferenceGraphHash(env, subjectEntityId);
    await env.DB.prepare(
      `INSERT INTO person_verification_state (entity_id, reference_graph_hash, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(entity_id) DO UPDATE SET
         reference_graph_hash = excluded.reference_graph_hash,
         updated_at = datetime('now')`,
    ).bind(subjectEntityId, hash).run();
  } catch (e) {
    console.warn("reference_graph_hash persist failed", (e as Error).message);
  }

  return summary;
}
