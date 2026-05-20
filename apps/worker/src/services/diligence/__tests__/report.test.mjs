// Task #6: markdown + JSON + PDF-inputs report-builder tests.
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildMarkdownReport, buildJsonBundle, buildPdfInputs } =
  await import("../../../../test-dist/services/diligence/report.js");

const run = {
  id: "run_abc", template_id: "tmpl_default", target_entity_id: "ent_1",
  triggered_by: "op@example.com", status: "completed", overall_score: 73.2,
  checks_total: 3, checks_completed: 3,
  by_status: { pass: 2, fail: 1, caution: 0, "n/a": 0, needs_human: 0 },
  parent_run_id: null, started_at: "2025-05-20T00:00:00Z",
  finished_at: "2025-05-20T00:00:10Z", created_at: "2025-05-20T00:00:00Z",
};
const results = [
  { id: "r1", run_id: "run_abc", check_key: "corporate.delaware_confirmed",
    section: "corporate", title: "Delaware incorporation confirmed",
    status: "pass", severity: "high", confidence: 0.95,
    finding_md: "**Delaware confirmed** ✓", evidence: ["https://e1"],
    flagged_for_human: 0, duration_ms: 12, created_at: "2025-05-20T00:00:01Z" },
  { id: "r2", run_id: "run_abc", check_key: "financial.burn_runway",
    section: "financial", title: "Burn vs runway",
    status: "fail", severity: "high", confidence: 0.8,
    finding_md: "Only 3 months runway", evidence: [],
    flagged_for_human: 0, duration_ms: 8, created_at: "2025-05-20T00:00:02Z" },
  { id: "r3", run_id: "run_abc", check_key: "ip.patents_owned",
    section: "ip", title: "Patents owned",
    status: "pass", severity: "low", confidence: 0.9,
    finding_md: "5 patents", evidence: [], flagged_for_human: 0,
    duration_ms: 4, created_at: "2025-05-20T00:00:03Z" },
];

test("buildMarkdownReport — includes header, sections, evidence", () => {
  const md = buildMarkdownReport(run, results);
  assert.match(md, /# Diligence report — ent_1/);
  assert.match(md, /## Corporate/);
  assert.match(md, /## Financial/);
  assert.match(md, /## Ip/);
  assert.match(md, /Delaware incorporation confirmed/);
  assert.match(md, /https:\/\/e1/);
  assert.match(md, /73\.2 \/ 100/);
});

test("buildMarkdownReport — re-run reference when parent set", () => {
  const md = buildMarkdownReport({ ...run, parent_run_id: "run_xyz" }, results);
  assert.match(md, /Re-run of:.*run_xyz/);
});

test("buildJsonBundle — round-trip preserves shape", () => {
  const out = buildJsonBundle(run, results);
  assert.equal(out.run.id, "run_abc");
  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].flagged_for_human, false);
  assert.equal(out.results[0].evidence[0], "https://e1");
});

test("buildPdfInputs — headers and rows match pdfResponse contract", () => {
  const out = buildPdfInputs(run, results);
  assert.deepEqual(out.headers, ["Section", "Check", "Status", "Severity", "Finding"]);
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[0].Status, "pass");
  assert.equal(out.filename, "diligence_run_abc");
  // Finding column is markdown-stripped + clipped to 140 chars.
  assert.ok(out.rows[0].Finding.length <= 140);
  assert.ok(!out.rows[0].Finding.includes("**"));
});
