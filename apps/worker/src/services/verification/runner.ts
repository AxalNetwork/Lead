// Verification orchestrator — gathers every claim attached to a person,
// dispatches to the matching verifier, and writes one
// verification_findings row per (person, claim_predicate, claim_value).
//
// Idempotent: re-runs that produce the same status update only
// `observed_at`; status changes append a new is_current=1 row and mark
// the prior one superseded (mirrors the Task #1 supersedes-chain).
//
// Every derived business fact (person.education.verified, …) flows
// through insertFact per the Task #1 canonical write contract.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { educationVerifier } from "./verifiers/education";
import { employmentVerifier } from "./verifiers/employment";
import { priorStartupVerifier } from "./verifiers/priorStartup";
import { litigationVerifier } from "./verifiers/litigation";
import { bankruptcyVerifier } from "./verifiers/bankruptcy";
import { directorshipVerifier } from "./verifiers/directorship";
import type { Claim, Verifier } from "./types";
import { canonicalize, sha256Hex } from "./util";

export const VERIFIERS: Verifier[] = [
  educationVerifier,
  employmentVerifier,
  priorStartupVerifier,
  litigationVerifier,
  bankruptcyVerifier,
  directorshipVerifier,
];

export interface RunSummary {
  person_entity_id: string;
  claims_seen: number;
  findings_written: number;
  by_status: Record<string, number>;
}

export async function gatherClaims(env: Env, personEntityId: string): Promise<Claim[]> {
  const claims: Claim[] = [];

  // Person display name — used by some verifiers (education).
  let personName = "";
  try {
    const u = await env.DB.prepare(`SELECT display_name FROM u_entities WHERE id = ?`).bind(personEntityId).first<{ display_name: string }>();
    personName = u?.display_name ?? "";
  } catch { /* ok */ }

  // Education claims.
  try {
    const r = await env.DB.prepare(
      `SELECT institution, degree, field, started_year, ended_year, source_url
         FROM education_history WHERE entity_id = ?`,
    ).bind(personEntityId).all<{ institution: string; degree: string | null; field: string | null; started_year: number | null; ended_year: number | null; source_url: string | null }>();
    for (const row of r.results ?? []) {
      const payload = { ...row, person_name: personName };
      const hash = await sha256Hex(`edu|${canonicalize(payload as unknown as Record<string, unknown>)}`);
      claims.push({
        predicate: "person.education",
        value_hash: hash,
        summary: `${row.degree ?? "Degree"} — ${row.institution}${row.ended_year ? ` (${row.ended_year})` : ""}`,
        payload: payload as unknown as Record<string, unknown>,
      });
    }
  } catch { /* table may be missing in some test envs */ }

  // Career claims.
  try {
    const r = await env.DB.prepare(
      `SELECT organization_entity_id, organization_name, role_title, started_at, ended_at, source_url
         FROM career_history WHERE entity_id = ?`,
    ).bind(personEntityId).all<{ organization_entity_id: string | null; organization_name: string; role_title: string | null; started_at: string | null; ended_at: string | null; source_url: string | null }>();
    for (const row of r.results ?? []) {
      const hash = await sha256Hex(`car|${canonicalize(row as unknown as Record<string, unknown>)}`);
      claims.push({
        predicate: "person.career_entry",
        value_hash: hash,
        summary: `${row.role_title ?? "Role"} @ ${row.organization_name}`,
        payload: row as unknown as Record<string, unknown>,
      });
    }
  } catch { /* */ }

  // Board claims.
  try {
    const r = await env.DB.prepare(
      `SELECT organization_entity_id, organization_name, role, started_at, ended_at, source_url
         FROM board_seats WHERE entity_id = ?`,
    ).bind(personEntityId).all<{ organization_entity_id: string | null; organization_name: string; role: string | null; started_at: string | null; ended_at: string | null; source_url: string | null }>();
    for (const row of r.results ?? []) {
      // Carry person_name through so the directorship verifier can
      // match against Companies House / press cooccurrence sources
      // without having to re-query u_entities.
      const payload = { ...(row as unknown as Record<string, unknown>), person_name: personName };
      const hash = await sha256Hex(`bd|${canonicalize(payload)}`);
      claims.push({
        predicate: "person.board_seat",
        value_hash: hash,
        summary: `${row.role ?? "Board seat"} @ ${row.organization_name}`,
        payload,
      });
    }
  } catch { /* */ }

  // Prior-startup claims — from facts table where predicate = 'person.prior_startup'.
  try {
    const r = await env.DB.prepare(
      `SELECT value_json, evidence_url FROM facts
        WHERE entity_id = ? AND predicate = 'person.prior_startup' AND is_current = 1`,
    ).bind(personEntityId).all<{ value_json: string | null; evidence_url: string | null }>();
    for (const row of r.results ?? []) {
      let payload: Record<string, unknown> = {};
      try { payload = row.value_json ? JSON.parse(row.value_json) as Record<string, unknown> : {}; } catch { payload = {}; }
      if (row.evidence_url && !payload.source_url) payload.source_url = row.evidence_url;
      const hash = await sha256Hex(`ps|${canonicalize(payload)}`);
      claims.push({
        predicate: "person.prior_startup",
        value_hash: hash,
        summary: `Prior startup: ${String(payload.company_name ?? "unknown")}`,
        payload,
      });
    }
  } catch { /* */ }

  // Synthetic litigation + bankruptcy "checks" (one per person, idempotent).
  if (personName) {
    const litPayload = { person_name: personName };
    claims.push({
      predicate: "person.litigation_check",
      value_hash: await sha256Hex(`lit|${personName}`),
      summary: `Federal civil-litigation check`,
      payload: litPayload,
    });
    claims.push({
      predicate: "person.bankruptcy_check",
      value_hash: await sha256Hex(`bkr|${personName}`),
      summary: `PACER bankruptcy check`,
      payload: { person_name: personName },
    });
  }

  return claims;
}

async function findPriorFinding(env: Env, personId: string, claim: Claim): Promise<{ id: string; status: string } | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT id, status FROM verification_findings
        WHERE person_entity_id = ? AND claim_predicate = ? AND claim_value_hash = ?
          AND is_current = 1
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(personId, claim.predicate, claim.value_hash).first<{ id: string; status: string }>();
    return r ?? null;
  } catch { return null; }
}

export async function runVerifiers(env: Env, personEntityId: string): Promise<RunSummary> {
  const claims = await gatherClaims(env, personEntityId);
  const summary: RunSummary = {
    person_entity_id: personEntityId,
    claims_seen: claims.length,
    findings_written: 0,
    by_status: {},
  };

  for (const claim of claims) {
    const verifier = VERIFIERS.find((v) => v.supports(claim));
    if (!verifier) continue;
    let result;
    try {
      result = await verifier.verify(env, personEntityId, claim);
    } catch (e) {
      result = { status: "unverifiable" as const, confidence: 0.1, reason: `verifier_error:${(e as Error).message}` };
    }

    const prior = await findPriorFinding(env, personEntityId, claim);
    // Strict append-only: same-status re-runs write NO row at all
    // (never UPDATE an existing finding in place). The prior row stays
    // is_current=1 unchanged; counts roll up the latest observation.
    if (prior && prior.status === result.status) {
      summary.by_status[result.status] = (summary.by_status[result.status] ?? 0) + 1;
      continue;
    }

    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO verification_findings
          (id, person_entity_id, claim_predicate, claim_value_hash, claim_summary,
           verifier_name, verifier_version, status, confidence,
           evidence_snippet, evidence_url, sources_json, reason, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        id, personEntityId, claim.predicate, claim.value_hash, claim.summary,
        verifier.name, verifier.version, result.status, result.confidence,
        result.evidence_snippet ?? null, result.evidence_url ?? null,
        result.sources && result.sources.length ? JSON.stringify(result.sources) : null,
        result.reason ?? null,
      ).run();
      if (prior) {
        await env.DB.prepare(
          `UPDATE verification_findings SET is_current = 0, superseded_by = ? WHERE id = ?`,
        ).bind(id, prior.id).run();
      }
      summary.findings_written += 1;
    } catch (e) {
      console.warn("verification_findings insert failed", (e as Error).message);
      continue;
    }
    summary.by_status[result.status] = (summary.by_status[result.status] ?? 0) + 1;

    // Mirror derived facts through insertFact (Task #1 contract).
    // Observational predicates (federal_hits=N, outcome=quietly_shut_down)
    // are persisted for confirmed AND contradicted outcomes — both are
    // factual observations of public-record state. Only 'unverifiable'
    // and 'skipped' are withheld (we observed nothing).
    if ((result.status === "confirmed" || result.status === "contradicted") && result.derived_predicate) {
      try {
        await insertFact(env, {
          entity_id: personEntityId,
          predicate: result.derived_predicate,
          value_text: result.derived_value_text ?? null,
          value_json: result.derived_value_json ?? null,
          source_kind: "enrichment",
          source: `verifier:${verifier.name}`,
          evidence_url: result.evidence_url ?? null,
          confidence: result.confidence,
        });
      } catch (e) {
        console.warn("derived fact insert failed", (e as Error).message);
      }
    }
  }

  // Update verification state.
  try {
    const claimsHashInput = claims.map((c) => `${c.predicate}|${c.value_hash}`).sort().join("\n");
    const claimsHash = await sha256Hex(claimsHashInput);
    await env.DB.prepare(
      `INSERT INTO person_verification_state (entity_id, last_verified_at, claims_hash, updated_at)
       VALUES (?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(entity_id) DO UPDATE SET
         last_verified_at = excluded.last_verified_at,
         claims_hash = excluded.claims_hash,
         updated_at = datetime('now')`,
    ).bind(personEntityId, claimsHash).run();
  } catch (e) {
    console.warn("person_verification_state upsert failed", (e as Error).message);
  }

  return summary;
}

/**
 * Nightly sweep — re-verify up to `limit` stalest persons whose
 * Verification tab was viewed in the last 30 days OR whose claims
 * (claims_hash) changed since last_verified_at.
 */
export async function runNightlyVerificationSweep(env: Env, limit = 200): Promise<{ picked: number; findings: number; claims_changed: number; verified_ids: string[] }> {
  let findings = 0;
  let claimsChanged = 0;
  const verifiedIds: string[] = [];
  try {
    // Spec criterion: re-verify the 200 stalest persons whose
    // Verification tab was viewed in the last 30 days OR whose claims
    // changed since last_verified_at. Both clauses, no broad time-based
    // sweep.
    const r = await env.DB.prepare(
      `SELECT entity_id, claims_hash FROM person_verification_state
        WHERE last_verified_at IS NULL
           OR last_viewed_at >= datetime('now','-30 days')
        ORDER BY COALESCE(last_verified_at, '1970-01-01') ASC
        LIMIT ?`,
    ).bind(limit).all<{ entity_id: string; claims_hash: string | null }>();
    const primary = r.results ?? [];

    // Discovery pool — persons with verifiable claims that have no
    // person_verification_state row yet. Without this branch, the
    // sweep would only ever revisit already-known persons and never
    // pick up newly-ingested ones. Union the three claim sources;
    // each table is optional (test DBs may lack it).
    const seenForDiscovery = new Set(primary.map((p) => p.entity_id));
    const discoveryRoom = Math.max(0, limit - primary.length);
    if (discoveryRoom > 0) {
      try {
        const disc = await env.DB.prepare(
          `SELECT DISTINCT entity_id FROM (
             SELECT entity_id FROM career_history
             UNION SELECT entity_id FROM education_history
             UNION SELECT entity_id FROM board_seats
           ) c
           WHERE entity_id NOT IN (SELECT entity_id FROM person_verification_state)
           LIMIT ?`,
        ).bind(discoveryRoom).all<{ entity_id: string }>();
        for (const row of disc.results ?? []) {
          if (seenForDiscovery.has(row.entity_id)) continue;
          primary.push({ entity_id: row.entity_id, claims_hash: null });
          seenForDiscovery.add(row.entity_id);
        }
      } catch { /* claim source tables optional in test DBs */ }
    }

    // Claims-changed pool — recompute the current claims_hash for
    // persons not already in the primary pool and compare against the
    // stored hash. Bounded so the tick stays cheap.
    const seen = new Set(primary.map((p) => p.entity_id));
    const remaining = Math.max(0, limit - primary.length);
    const changedPicks: Array<{ entity_id: string; claims_hash: string | null }> = [];
    if (remaining > 0) {
      try {
        const cand = await env.DB.prepare(
          `SELECT entity_id, claims_hash FROM person_verification_state
            WHERE last_verified_at IS NOT NULL
            ORDER BY datetime(last_verified_at) ASC
            LIMIT ?`,
        ).bind(Math.min(remaining * 4, 1000)).all<{ entity_id: string; claims_hash: string | null }>();
        for (const row of cand.results ?? []) {
          if (seen.has(row.entity_id) || changedPicks.length >= remaining) continue;
          try {
            const claims = await gatherClaims(env, row.entity_id);
            const input = claims.map((c) => `${c.predicate}|${c.value_hash}`).sort().join("\n");
            const currentHash = await sha256Hex(input);
            if (currentHash !== (row.claims_hash ?? "")) {
              changedPicks.push(row);
              claimsChanged += 1;
            }
          } catch { /* skip */ }
        }
      } catch { /* secondary pool optional */ }
    }

    for (const row of [...primary, ...changedPicks]) {
      try {
        const s = await runVerifiers(env, row.entity_id);
        findings += s.findings_written;
        verifiedIds.push(row.entity_id);
      } catch (e) {
        console.warn("nightly verify failed", row.entity_id, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("nightly verification sweep failed", (e as Error).message);
  }
  return { picked: verifiedIds.length, findings, claims_changed: claimsChanged, verified_ids: verifiedIds };
}

/**
 * Nightly reference-graph sweep — pick persons whose
 * reference_graph_hash differs from the currently-computed hash, plus
 * persons present in any graph source but missing from
 * person_verification_state. Returns the entity ids to rebuild.
 *
 * Caller (scheduled.ts) is responsible for invoking
 * buildReferenceCandidates(env, id) for each returned id — that
 * builder also updates the stored hash so the next tick won't
 * re-pick the same id unless the graph actually changed.
 */
export async function pickReferenceGraphChanged(env: Env, limit = 200): Promise<string[]> {
  const { computeReferenceGraphHash } = await import("./references.js");
  const picks: string[] = [];
  const seen = new Set<string>();

  // 1. Existing rows: compare stored hash vs current.
  try {
    const r = await env.DB.prepare(
      `SELECT entity_id, reference_graph_hash FROM person_verification_state
        ORDER BY datetime(COALESCE(updated_at, '1970-01-01')) ASC
        LIMIT ?`,
    ).bind(Math.min(limit * 4, 1000)).all<{ entity_id: string; reference_graph_hash: string | null }>();
    for (const row of r.results ?? []) {
      if (picks.length >= limit) break;
      try {
        const cur = await computeReferenceGraphHash(env, row.entity_id);
        if (cur !== (row.reference_graph_hash ?? "")) {
          picks.push(row.entity_id);
          seen.add(row.entity_id);
        }
      } catch { /* skip */ }
    }
  } catch { /* */ }

  // 2. Discovery: persons present in a graph source but unknown to
  //    person_verification_state — first-time references build.
  if (picks.length < limit) {
    const room = limit - picks.length;
    try {
      const d = await env.DB.prepare(
        `SELECT DISTINCT entity_id FROM (
           SELECT entity_id FROM publication_authors
           UNION SELECT entity_id FROM conference_attendees
           UNION SELECT entity_id FROM accelerator_batches
           UNION SELECT entity_id FROM board_seats
           UNION SELECT entity_id FROM career_history
         ) g
         WHERE entity_id NOT IN (SELECT entity_id FROM person_verification_state)
         LIMIT ?`,
      ).bind(room).all<{ entity_id: string }>();
      for (const row of d.results ?? []) {
        if (picks.length >= limit) break;
        if (seen.has(row.entity_id)) continue;
        picks.push(row.entity_id);
        seen.add(row.entity_id);
      }
    } catch { /* optional tables */ }
  }
  return picks;
}
