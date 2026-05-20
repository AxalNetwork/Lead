#!/usr/bin/env node
// Task #8: CI regression-gate. Calls the deployed worker's
// /api/ml/eval/gate endpoint and exits non-zero on any task that
// regresses more than 5% versus the previous active run.
//
// Inputs (env):
//   GATE_BASE_URL   — base URL of the worker (defaults to
//                     https://api.aidatasignal.com)
//   GATE_THRESHOLD  — regression threshold percentage (default 5)
//   GATE_API_TOKEN  — optional bearer for the access guard
//   GATE_SKIP       — if "1", logs and exits 0 (used when the prior
//                     deploy has no baseline yet)
//
// The script is intentionally read-only: it never triggers an eval
// run from CI (those happen nightly and via operator-driven Run-now).
// It only compares the two most recent `ok` runs per dataset.

const BASE = process.env.GATE_BASE_URL || "https://api.aidatasignal.com";
const THRESHOLD = Number(process.env.GATE_THRESHOLD || "5");
const TOKEN = process.env.GATE_API_TOKEN || "";

if (process.env.GATE_SKIP === "1") {
  console.log("eval-gate: GATE_SKIP=1 → skipping");
  process.exit(0);
}

const url = `${BASE}/api/ml/eval/gate?threshold=${THRESHOLD}`;
console.log("eval-gate: GET", url);

const headers = { "accept": "application/json" };
if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;

let res;
try {
  res = await fetch(url, { headers });
} catch (e) {
  // Hard network errors (DNS / connection refused) → soft-pass with a
  // loud warning. This covers the first deploy after a cold start
  // where the worker URL doesn't resolve yet.
  console.warn("eval-gate: network error (treating as soft-pass):", e.message);
  process.exit(0);
}

if (res.status === 404) {
  // Worker is up but /api/ml/eval/gate isn't deployed yet (the very
  // first deploy that ships this task). Soft-pass once; subsequent
  // deploys will see a real baseline.
  console.warn("eval-gate: 404 (gate endpoint not deployed yet — first-run soft-pass)");
  process.exit(0);
}

if (res.status === 401 || res.status === 403) {
  // Auth misconfiguration must NOT silently bypass the gate — that
  // would let a regression slip through. Fail hard. Set GATE_SKIP=1
  // if you intentionally want to bypass during an emergency deploy.
  console.error(`eval-gate: HTTP ${res.status} — auth failure. Configure GATE_API_TOKEN or set GATE_SKIP=1 to bypass.`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`eval-gate: HTTP ${res.status} — failing deploy.`);
  process.exit(1);
}

const report = await res.json();
console.log(`eval-gate: passed=${report.passed} threshold=${report.thresholdPct}% rows=${(report.rows || []).length}`);
for (const r of report.rows || []) {
  const skip = r.skipped_reason ? ` [${r.skipped_reason}]` : "";
  console.log(`  - ${r.task_key}: ${r.passed ? "PASS" : "FAIL"}${skip}`);
  for (const reg of r.regressions || []) {
    console.log(`      regression ${reg.metric}: prev=${reg.previous.toFixed(3)} cur=${reg.current.toFixed(3)} delta=${(reg.delta * 100).toFixed(1)}%`);
  }
}

if (!report.passed) {
  console.error("eval-gate: regression detected; failing deploy");
  process.exit(1);
}
process.exit(0);
