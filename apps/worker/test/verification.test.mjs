// Task #14: orchestrator idempotency + reference-builder coverage.
//
// We exercise the runner + reference builder against an in-memory mock
// D1 stub (no real D1 dependency). The mock implements just enough of
// the env.DB.prepare(...).bind(...).first/all/run API to satisfy the
// queries in services/verification/*.

import { test } from "node:test";
import assert from "node:assert/strict";

const { runVerifiers } = await import("../test-dist/services/verification/runner.js");
const { buildReferenceCandidates } = await import("../test-dist/services/verification/references.js");

function makeDB() {
  // Tables (in-memory).
  const tables = {
    u_entities: [],
    education_history: [],
    career_history: [],
    board_seats: [],
    facts: [],
    verification_findings: [],
    person_verification_state: [],
    reference_candidates: [],
    publication_authors: [],
    conference_attendance: [],
    accelerator_batches: [],
    deal_events: [],
  };

  function match(rows, sql, args) {
    // Tiny pattern-matched query router. Sufficient for our tests.
    const s = sql.replace(/\s+/g, " ").trim();
    if (/SELECT display_name FROM u_entities WHERE id = \?/.test(s)) {
      return tables.u_entities.filter((r) => r.id === args[0]).map((r) => ({ display_name: r.display_name }));
    }
    if (/FROM education_history WHERE entity_id = \?/.test(s)) {
      return tables.education_history.filter((r) => r.entity_id === args[0]);
    }
    if (/FROM career_history WHERE entity_id = \?/.test(s)) {
      return tables.career_history.filter((r) => r.entity_id === args[0])
        .map((r) => ({ organization_entity_id: r.organization_entity_id, organization_name: r.organization_name, role_title: r.role_title, started_at: r.started_at, ended_at: r.ended_at, source_url: r.source_url, org_id: r.organization_entity_id, org_name: r.organization_name }));
    }
    if (/FROM board_seats WHERE entity_id = \?/.test(s)) {
      return tables.board_seats.filter((r) => r.entity_id === args[0])
        .map((r) => ({ organization_entity_id: r.organization_entity_id, organization_name: r.organization_name, role: r.role, started_at: r.started_at, ended_at: r.ended_at, source_url: r.source_url, org_id: r.organization_entity_id, org_name: r.organization_name }));
    }
    if (/FROM facts WHERE entity_id = \? AND predicate = 'person.prior_startup'/.test(s)) {
      return tables.facts.filter((r) => r.entity_id === args[0] && r.predicate === "person.prior_startup" && r.is_current === 1);
    }
    if (/FROM sec_form4_insiders/.test(s) || /FROM firm_team_snapshots/.test(s) ||
        /FROM entity_mentions/.test(s) || /FROM sec_director_filings/.test(s)) {
      // Optional tables — return empty.
      return [];
    }
    if (/FROM deal_events/.test(s)) {
      return tables.deal_events.filter((r) => r.company_entity_id === args[0]);
    }
    if (/FROM verification_findings.*is_current = 1.*ORDER BY created_at DESC LIMIT 1/.test(s)) {
      // findPriorFinding
      const out = tables.verification_findings.filter(
        (r) => r.person_entity_id === args[0] && r.claim_predicate === args[1] && r.claim_value_hash === args[2] && r.is_current === 1,
      );
      out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      return out.slice(0, 1);
    }
    if (/FROM verification_findings.*is_current = 1.*ORDER BY status/.test(s)) {
      return tables.verification_findings.filter((r) => r.person_entity_id === args[0] && r.is_current === 1);
    }
    if (/FROM person_verification_state WHERE entity_id = \?/.test(s)) {
      return tables.person_verification_state.filter((r) => r.entity_id === args[0]);
    }
    if (/FROM career_history ch\s+LEFT JOIN u_entities/.test(s)) {
      // peers query
      const orgId = args[0], orgName = args[1], subj = args[2];
      return tables.career_history.filter((r) => (r.organization_entity_id === orgId || r.organization_name === orgName) && r.entity_id !== subj)
        .map((r) => {
          const u = tables.u_entities.find((u) => u.id === r.entity_id);
          return { pid: r.entity_id, pname: u?.display_name ?? null, started_at: r.started_at, ended_at: r.ended_at, role_title: r.role_title };
        });
    }
    if (/FROM board_seats bs\s+LEFT JOIN u_entities/.test(s)) {
      const orgId = args[0], orgName = args[1], subj = args[2];
      return tables.board_seats.filter((r) => (r.organization_entity_id === orgId || r.organization_name === orgName) && r.entity_id !== subj)
        .map((r) => {
          const u = tables.u_entities.find((u) => u.id === r.entity_id);
          return { pid: r.entity_id, pname: u?.display_name ?? null, started_at: r.started_at, ended_at: r.ended_at };
        });
    }
    if (/FROM publication_authors a1/.test(s)) {
      const subj = args[0];
      const subjPubs = tables.publication_authors.filter((r) => r.entity_id === subj).map((r) => r.publication_id);
      return tables.publication_authors.filter((r) => subjPubs.includes(r.publication_id) && r.entity_id !== subj)
        .map((r) => {
          const u = tables.u_entities.find((u) => u.id === r.entity_id);
          return { pid: r.entity_id, pname: u?.display_name ?? null, title: r.publication_title, published_at: r.published_at };
        });
    }
    if (/FROM conference_attendance a1/.test(s)) {
      // The real table identifies an event by (conference_name, year); there
      // is no conference_id column, so the join key is the pair.
      const subj = args[0];
      const key = (r) => `${r.conference_name}|${r.year}`;
      const subjConfs = tables.conference_attendance.filter((r) => r.entity_id === subj).map(key);
      return tables.conference_attendance.filter((r) => subjConfs.includes(key(r)) && r.entity_id !== subj)
        .map((r) => {
          const u = tables.u_entities.find((u) => u.id === r.entity_id);
          return { pid: r.entity_id, pname: u?.display_name ?? null, conf: r.conference_name, year: r.year };
        });
    }
    if (/FROM accelerator_batches b1/.test(s)) {
      const subj = args[0];
      const mine = tables.accelerator_batches.filter((r) => r.entity_id === subj);
      return tables.accelerator_batches.filter((r) =>
        r.entity_id !== subj && mine.some((m) => m.accelerator === r.accelerator && m.batch === r.batch)
      ).map((r) => {
        const u = tables.u_entities.find((u) => u.id === r.entity_id);
        return { pid: r.entity_id, pname: u?.display_name ?? null, acc: r.accelerator, batch: r.batch };
      });
    }
    return [];
  }

  function exec(sql, args) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^INSERT INTO verification_findings/.test(s)) {
      const [id, person_entity_id, claim_predicate, claim_value_hash, claim_summary, verifier_name, verifier_version, status, confidence, evidence_snippet, evidence_url, sources_json, reason] = args;
      tables.verification_findings.push({
        id, person_entity_id, claim_predicate, claim_value_hash, claim_summary,
        verifier_name, verifier_version, status, confidence, evidence_snippet, evidence_url, sources_json, reason,
        is_current: 1, superseded_by: null, created_at: new Date().toISOString(),
      });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE verification_findings SET is_current = 0, superseded_by = \?/.test(s)) {
      const [supId, rowId] = args;
      const row = tables.verification_findings.find((r) => r.id === rowId);
      if (row) { row.is_current = 0; row.superseded_by = supId; }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/^UPDATE verification_findings SET created_at/.test(s)) {
      const row = tables.verification_findings.find((r) => r.id === args[0]);
      if (row) row.created_at = new Date().toISOString();
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (/^INSERT INTO person_verification_state/.test(s) && /last_verified_at/.test(s)) {
      const [entity_id, claims_hash] = args;
      const existing = tables.person_verification_state.find((r) => r.entity_id === entity_id);
      if (existing) { existing.last_verified_at = new Date().toISOString(); existing.claims_hash = claims_hash; }
      else tables.person_verification_state.push({ entity_id, last_verified_at: new Date().toISOString(), last_viewed_at: null, claims_hash });
      return { meta: { changes: 1 } };
    }
    if (/^INSERT INTO facts/.test(s)) {
      // insertFact path — we just record it.
      tables.facts.push({ id: args[0], entity_id: args[1], predicate: args[2], value_text: args[3], value_number: args[4], value_json: args[5], is_current: 1 });
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE facts SET observed_at/.test(s)) return { meta: { changes: 0 } };
    if (/^INSERT INTO reference_candidates/.test(s)) {
      const [id, subject_entity_id, ref_entity_id, ref_display_name, relationship_kind, shared_context, time_overlap_months, confidence, reasoning, evidence_url, builder_version] = args;
      const key = `${subject_entity_id}|${ref_display_name}|${relationship_kind}|${shared_context ?? ""}`;
      const existing = tables.reference_candidates.find((r) => `${r.subject_entity_id}|${r.ref_display_name}|${r.relationship_kind}|${r.shared_context ?? ""}` === key);
      if (existing) {
        existing.confidence = confidence; existing.reasoning = reasoning;
        existing.time_overlap_months = time_overlap_months; existing.evidence_url = evidence_url;
      } else {
        tables.reference_candidates.push({ id, subject_entity_id, ref_entity_id, ref_display_name, relationship_kind, shared_context, time_overlap_months, confidence, reasoning, evidence_url, builder_version });
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  return {
    tables,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first(_typed) { const rows = match(tables, sql, args); return rows[0] ?? null; },
            async all(_typed) { const rows = match(tables, sql, args); return { results: rows }; },
            async run() { return exec(sql, args); },
          };
        },
      };
    },
  };
}

function makeEnv() {
  return { DB: makeDB(), SCRAPE_CACHE: { async get() { return null; }, async put() { /*noop*/ } }, ALLOWED_EMAIL: "x@y" };
}

test("orchestrator emits one finding per claim and is idempotent on re-run", async () => {
  const env = makeEnv();
  const personId = "p1";
  env.DB.tables.u_entities.push({ id: personId, display_name: "Jane Doe" });
  env.DB.tables.education_history.push({
    entity_id: personId, institution: "Some Tiny College", degree: "BS", field: "CS",
    started_year: 2010, ended_year: 2014, source_url: "https://ex/edu",
  });

  const r1 = await runVerifiers(env, personId);
  assert.ok(r1.claims_seen >= 1, "should see claims");
  assert.ok(r1.findings_written >= 1, "first run writes findings");
  const firstCount = env.DB.tables.verification_findings.length;
  assert.ok(firstCount >= 1);

  // Second run — same inputs — should NOT add new rows (touch only).
  const r2 = await runVerifiers(env, personId);
  assert.equal(r2.findings_written, 0, "idempotent re-run writes no new findings");
  assert.equal(env.DB.tables.verification_findings.length, firstCount);
});

test("orchestrator supersedes prior finding when status changes", async () => {
  const env = makeEnv();
  const personId = "p2";
  env.DB.tables.u_entities.push({ id: personId, display_name: "John Roe" });

  // Hand-craft a prior 'confirmed' finding so the next run flips to 'unverifiable'.
  const priorId = "prior";
  const litHash = await (await import("../test-dist/services/verification/util.js")).sha256Hex("lit|John Roe");
  env.DB.tables.verification_findings.push({
    id: priorId, person_entity_id: personId, claim_predicate: "person.litigation_check",
    claim_value_hash: litHash, claim_summary: "x", verifier_name: "litigation", verifier_version: "0.1.0",
    status: "confirmed", confidence: 0.7, is_current: 1, created_at: new Date().toISOString(),
  });

  await runVerifiers(env, personId);
  const litRows = env.DB.tables.verification_findings.filter((r) => r.claim_predicate === "person.litigation_check");
  assert.equal(litRows.length, 2, "supersedes-chain creates new row, keeps prior");
  const current = litRows.filter((r) => r.is_current === 1);
  assert.equal(current.length, 1, "exactly one is_current=1 per claim");
  assert.equal(current[0].status, "unverifiable", "new status reflects unconfigured CourtListener");
  const old = litRows.find((r) => r.id === priorId);
  assert.equal(old.is_current, 0);
  assert.equal(old.superseded_by, current[0].id);
});

test("reference builder produces rows from every wired discovery pass", async () => {
  const env = makeEnv();
  const subject = "S";
  env.DB.tables.u_entities.push(
    { id: subject, display_name: "Subject" },
    { id: "A", display_name: "Alice Co-Founder" },
    { id: "B", display_name: "Bob Early Eng" },
    { id: "C", display_name: "Carol Board Peer" },
    { id: "D", display_name: "Dave Co-Author" },
    { id: "E", display_name: "Eve Co-Panelist" },
    { id: "F", display_name: "Frank YC Batchmate" },
  );
  env.DB.tables.career_history.push(
    { entity_id: subject, organization_entity_id: "org1", organization_name: "Acme", role_title: "Founder", started_at: "2014-01", ended_at: "2019-01" },
    { entity_id: "A", organization_entity_id: "org1", organization_name: "Acme", role_title: "Co-Founder", started_at: "2014-02", ended_at: "2019-01" },
    { entity_id: "B", organization_entity_id: "org1", organization_name: "Acme", role_title: "Engineer", started_at: "2014-06", ended_at: "2018-12" },
  );
  env.DB.tables.board_seats.push(
    { entity_id: subject, organization_entity_id: "org2", organization_name: "BoardCo", role: "director", started_at: "2018-01", ended_at: "2022-01" },
    { entity_id: "C", organization_entity_id: "org2", organization_name: "BoardCo", role: "director", started_at: "2019-01", ended_at: "2023-01" },
  );
  env.DB.tables.publication_authors.push(
    { entity_id: subject, publication_id: "pub1", publication_title: "Paper", published_at: "2020-01" },
    { entity_id: "D", publication_id: "pub1", publication_title: "Paper", published_at: "2020-01" },
  );
  // No conference_id column exists on conference_attendance; the natural key
  // is (entity_id, conference_name, year).
  env.DB.tables.conference_attendance.push(
    { entity_id: subject, conference_name: "NeurIPS", year: 2022 },
    { entity_id: "E", conference_name: "NeurIPS", year: 2022 },
  );
  env.DB.tables.accelerator_batches.push(
    { entity_id: subject, accelerator: "YC", batch: "W19" },
    { entity_id: "F", accelerator: "YC", batch: "W19" },
  );

  const s = await buildReferenceCandidates(env, subject);
  assert.ok(s.by_kind.co_founder >= 1, "co_founder pass");
  assert.ok(s.by_kind.early_employee >= 1, "early_employee pass");
  assert.ok(s.by_kind.board_peer >= 1, "board_peer pass");
  assert.ok(s.by_kind.co_author >= 1, "co_author pass");
  assert.ok(s.by_kind.co_panelist >= 1, "co_panelist pass");
  assert.ok(s.by_kind.batch_cohort >= 1, "batch_cohort pass");

  // Re-run is idempotent.
  const beforeCount = env.DB.tables.reference_candidates.length;
  await buildReferenceCandidates(env, subject);
  assert.equal(env.DB.tables.reference_candidates.length, beforeCount, "rebuild is idempotent (upsert)");
});
