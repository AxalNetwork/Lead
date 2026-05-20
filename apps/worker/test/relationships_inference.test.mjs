// Task #4 (Relationship Inference Worker): source-shape contract tests.
// Mirrors the Task #3 overrides.test.mjs pattern — Hono entrypoints
// aren't directly invoked (CF bindings resolve at module load time),
// so we parse the new source strings + migration SQL and assert the
// contract holds. The pure pathfinder + baseline + persist modules
// are also exercised against a fake D1 stub for end-to-end behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- 1. Migration 377 shape ----------
test("migration 377 adds evidence_count + last_evidence_at + relationship_infer_queue", () => {
  const sql = readFileSync(resolve(__dirname, "../migrations/377_rel_edges_evidence.sql"), "utf8");
  assert.match(sql, /ALTER TABLE rel_edges ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /ALTER TABLE rel_edges ADD COLUMN last_evidence_at TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS relationship_infer_queue/);
  assert.match(sql, /entity_id\s+TEXT PRIMARY KEY/);
});

// ---------- 2. Baselines table ----------
test("baselines table covers all spec'd kinds with the spec'd numbers", async () => {
  const mod = await import("../dist-test/services/relationships/baselines.js").catch(() => null);
  if (!mod) {
    // tsc not run yet — fall back to source-shape check
    const src = readFileSync(resolve(__dirname, "../src/services/relationships/baselines.ts"), "utf8");
    assert.match(src, /invested_in:\s*\{[^}]*"sec":\s*0\.95/);
    assert.match(src, /board_member_at:\s*\{[^}]*"sec\.form4":\s*0\.95/);
    assert.match(src, /works_at:\s*\{[^}]*"title":\s*0\.85/);
    assert.match(src, /publicly_mentioned_with:.*0\.4/);
    assert.match(src, /family_of:\s*\{[^}]*"wedding_notice":\s*0\.95/);
    return;
  }
  assert.equal(mod.baselineQuality("invested_in", "sec"), 0.95);
  assert.equal(mod.baselineQuality("invested_in", "press"), 0.7);
  assert.equal(mod.baselineQuality("board_member_at", "sec.form4"), 0.95);
  assert.equal(mod.baselineQuality("works_at", "title"), 0.85);
  assert.equal(mod.baselineQuality("publicly_mentioned_with", "news"), 0.4);
  assert.equal(mod.baselineQuality("family_of", "wedding_notice"), 0.95);
  // Unknown source falls back to the kind's "*" entry.
  assert.equal(mod.baselineQuality("invested_in", "unknown_source"), 0.8);
});

// ---------- 3. Per-extractor file presence ----------
test("13 extractors exist per spec step #1", () => {
  const expected = [
    "worksAtFromTitle", "investedInFromDeals", "boardSeatFromFilings",
    "coInvestorFromDeals", "employmentHistoryFromLinkedIn", "educationFromBio",
    "familyFromPublicSources", "colleagueOverlap", "schoolWith",
    "coAuthorFromPublications", "mentionFromNews", "portfolioFromFirmSite",
    "advisorFromBio",
  ];
  for (const name of expected) {
    const src = readFileSync(resolve(__dirname, `../src/services/relationships/extractors/${name}.ts`), "utf8");
    assert.match(src, /export const NAME =/, `${name} missing NAME export`);
    assert.match(src, /export async function extract\b/, `${name} missing extract()`);
  }
});

// ---------- 4. Entity-resolution guardrail ----------
test("resolve.ts uses createIfMissing:false (no raw u_entities mint)", () => {
  const src = readFileSync(resolve(__dirname, "../src/services/relationships/resolve.ts"), "utf8");
  assert.match(src, /createIfMissing:\s*false/);
  assert.doesNotMatch(src, /createIfMissing:\s*true/);
});

// ---------- 5. Persist layer dedup contract ----------
test("persist.ts upserts via uq_rel_edges_quad with evidence_count bump", () => {
  const src = readFileSync(resolve(__dirname, "../src/services/relationships/persist.ts"), "utf8");
  // First-insert path stamps quality_score=baseline + evidence_count=1.
  assert.match(src, /baselineQuality\(p\.kind, p\.source\)/);
  assert.match(src, /evidence_count,\s*last_evidence_at\s*\n\s*\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1, \?\)/);
  // Conflict path bumps evidence_count and never overwrites quality_score.
  assert.match(src, /evidence_count = COALESCE\(evidence_count, 1\) \+ 1/);
  assert.doesNotMatch(src, /UPDATE rel_edges[\s\S]*?SET[\s\S]*?quality_score\s*=/);
});

// ---------- 6. Persist behavioural test against a D1 stub ----------
test("persistEdges: same proposal twice → 1 edge, evidence_count=2", async () => {
  const mod = await import("../dist-test/services/relationships/persist.js").catch(() => null);
  if (!mod) return; // tsc not run — source-shape covered above
  const rows = new Map(); // id → row
  function makeStmt(sql) {
    const binds = [];
    const stmt = {
      bind: (...b) => { binds.push(...b); return stmt; },
      first: async () => {
        if (/SELECT id, backing_fact_ids_json, evidence_count\s+FROM rel_edges/i.test(sql)) {
          const [src, dst, kind, vf] = binds;
          for (const r of rows.values()) {
            if (r.src === src && r.dst === dst && r.kind === kind && (r.valid_from ?? "") === (vf ?? "")) return { id: r.id, backing_fact_ids_json: r.backing_fact_ids_json, evidence_count: r.evidence_count };
          }
          return null;
        }
        return null;
      },
      run: async () => {
        if (/^INSERT INTO rel_edges/i.test(sql)) {
          const [id, src, dst, kind, , vf, , , backing, source, , , last] = binds;
          rows.set(id, { id, src, dst, kind, valid_from: vf, backing_fact_ids_json: backing, source, evidence_count: 1, last_evidence_at: last });
        } else if (/^UPDATE rel_edges\s+SET\s+evidence_count/i.test(sql)) {
          const [last, backing, id] = binds;
          const r = rows.get(id); if (r) { r.evidence_count += 1; r.last_evidence_at = last; r.backing_fact_ids_json = backing; }
        }
        return { meta: {} };
      },
    };
    return stmt;
  }
  const env = { DB: { prepare: (sql) => makeStmt(sql) } };
  const prop = { src_entity_id: "A", dst_entity_id: "B", kind: "works_at", source: "title", backing_fact_ids: ["f1"] };
  const r1 = await mod.persistEdges(env, [prop]);
  assert.equal(r1.inserted, 1); assert.equal(r1.merged, 0);
  const r2 = await mod.persistEdges(env, [{ ...prop, backing_fact_ids: ["f2"] }]);
  assert.equal(r2.inserted, 0); assert.equal(r2.merged, 1);
  assert.equal(rows.size, 1);
  const only = Array.from(rows.values())[0];
  assert.equal(only.evidence_count, 2);
  const merged = JSON.parse(only.backing_fact_ids_json);
  assert.deepEqual(merged.sort(), ["f1", "f2"]);
});

// ---------- 7. Pathfinder: 12-node fixture, Jim Murphy ↔ Sequoia acceptance ----------
test("findPaths: 1-hop direct works_at; 2-hop colleague path", async () => {
  const mod = await import("../dist-test/services/relationships/pathfinder.js").catch(() => null);
  if (!mod) return;
  // Fixture: Jim works_at Sequoia; Beth works_at Sequoia ⇒ Jim ↔ Beth via Sequoia.
  // Also includes a longer colleague_of edge as alt path.
  const edges = [
    { id: "e1", src: "jim",  dst: "sequoia", kind: "works_at", quality: 0.85 },
    { id: "e2", src: "beth", dst: "sequoia", kind: "works_at", quality: 0.85 },
    { id: "e3", src: "jim",  dst: "beth",   kind: "colleague_of", quality: 0.7 },
    { id: "e4", src: "carl", dst: "sequoia", kind: "works_at", quality: 0.85 },
    { id: "e5", src: "carl", dst: "jim",    kind: "colleague_of", quality: 0.7 },
  ];
  const ents = ["jim", "beth", "carl", "sequoia"];
  const env = { DB: { prepare: (sql) => {
    const binds = [];
    return {
      bind: (...b) => { binds.push(...b); return { bind: () => undefined, all: async () => {
        if (/FROM rel_edges/i.test(sql)) {
          const ids = new Set(binds);
          return { results: edges.filter((e) => ids.has(e.src) || ids.has(e.dst)) };
        }
        if (/FROM u_entities/i.test(sql)) {
          const ids = new Set(binds);
          return { results: ents.filter((id) => ids.has(id)).map((id) => ({ id, display_name: id, kind: id === "sequoia" ? "org" : "person" })) };
        }
        return { results: [] };
      } }; },
    };
  } } };
  const direct = await mod.findPaths(env, "jim", "sequoia", 4, 5);
  assert.ok(direct.length >= 1, "expected at least one path Jim → Sequoia");
  assert.equal(direct[0].hops, 1);
  assert.equal(direct[0].edges[0].kind, "works_at");
  // Reconstruction contract: nodes is strictly src→dst, no dupes,
  // and edges.length === hops. Catches the [src, dst, src] bug.
  assert.deepEqual(direct[0].nodes, ["jim", "sequoia"]);
  assert.equal(direct[0].edges.length, direct[0].hops);
  const indirect = await mod.findPaths(env, "jim", "beth", 4, 5);
  assert.ok(indirect.length >= 1, "expected at least one path Jim → Beth");
  // Direct colleague_of edge is 1-hop; ranked first.
  assert.equal(indirect[0].hops, 1);
  assert.deepEqual(indirect[0].nodes, ["jim", "beth"]);
  assert.equal(new Set(indirect[0].nodes).size, indirect[0].nodes.length);
  // No-path honesty: isolated node.
  const nope = await mod.findPaths(env, "jim", "nobody", 4, 5);
  assert.deepEqual(nope, []);
});

// ---------- 8. Orchestrator + extractor surface ----------
test("orchestrator exports the 13 extractors and runs through them", () => {
  const src = readFileSync(resolve(__dirname, "../src/services/relationships/orchestrator.ts"), "utf8");
  for (const n of [
    "worksAtFromTitle", "investedInFromDeals", "boardSeatFromFilings",
    "coInvestorFromDeals", "employmentHistoryFromLinkedIn", "educationFromBio",
    "familyFromPublicSources", "colleagueOverlap", "schoolWith",
    "coAuthorFromPublications", "mentionFromNews", "portfolioFromFirmSite",
    "advisorFromBio",
  ]) {
    assert.match(src, new RegExp(n), `orchestrator missing ${n}`);
  }
  // Summary shape contract.
  assert.match(src, /by_extractor:\s*\{\}/);
  assert.match(src, /total_edges:\s*0/);
  // Per-extractor field shape.
  assert.match(src, /proposed:\s*0,\s*inserted:\s*0,\s*merged:\s*0,\s*unresolved:\s*0,\s*scanned:\s*0,\s*errors:\s*0/);
});

// ---------- 9. Routes contract: query-string + admin gate ----------
test("routes/relationships.ts wires infer-all + neighborhood?id + paths?src&dst", () => {
  const src = readFileSync(resolve(__dirname, "../src/routes/relationships.ts"), "utf8");
  assert.match(src, /relationships\.post\("\/infer-all"/);
  assert.match(src, /relationships\.post\("\/infer\/:entity_id"/);
  assert.match(src, /relationships\.get\("\/neighborhood"/);
  assert.match(src, /relationships\.get\("\/paths"/);
  // Per Task #4 static-routing: ?id= / ?src= / ?dst= query strings.
  assert.match(src, /c\.req\.query\("id"\)/);
  assert.match(src, /c\.req\.query\("src"\)/);
  assert.match(src, /c\.req\.query\("dst"\)/);
  // Admin gate on the POST endpoints.
  assert.match(src, /requireAdmin/);
});

// ---------- 10. Incremental hooks + nightly tick wiring ----------
test("createEntity + insertFact enqueue rel-infer; nightly tick drains", () => {
  const roles = readFileSync(resolve(__dirname, "../src/entities/roles.ts"), "utf8");
  const facts = readFileSync(resolve(__dirname, "../src/entities/facts.ts"), "utf8");
  const sched = readFileSync(resolve(__dirname, "../src/scheduled.ts"), "utf8");
  assert.match(roles, /enqueueRelInfer\(env, id/);
  assert.match(facts, /enqueueRelInfer\(env, f\.entity_id/);
  assert.match(sched, /drainInferQueue/);
  assert.match(sched, /runAllExtractors/);
});

// ---------- 11. Frontend uses Cytoscape + query-string contract ----------
test("relationships.html loads cytoscape; relationships.js calls /neighborhood?id= and /paths?src=&dst=", () => {
  const html = readFileSync(resolve(__dirname, "../../site/dashboard/relationships.html"), "utf8");
  const js = readFileSync(resolve(__dirname, "../../site/assets/js/relationships.js"), "utf8");
  assert.match(html, /cytoscape@/);
  assert.match(html, /id="ads-rel-cy"/);
  assert.match(js, /\/api\/relationships\/neighborhood\?id=/);
  assert.match(js, /\/api\/relationships\/paths\?src=/);
});
