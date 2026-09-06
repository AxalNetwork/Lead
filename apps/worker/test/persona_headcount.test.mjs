// Persona matching could never score above 0.90, and always explained why
// with a line that was not true.
//
// scoreCompanySize carries weight 0.10 and returns 0 with the reason
// "company size unknown" when it has no headcount. personaMatching.ts asked
// facts for `org.headcount`, `org.employees`, `company.employees` and
// `company.headcount` — four predicate spellings that no writer in the
// worker has ever produced. So the component was zero for every entity
// against every persona: a hard ceiling of 0.90, and a permanent
// "company size unknown" in the rationale the dashboard shows to explain
// the match.
//
// The predicate that exists is bare `employees`: it is what the registry
// declares (entities/profile-predicates.ts) and what secEdgar/persist.ts
// writes. The fix converges on that name rather than inventing a fifth.
//
// This asserts the loop is closed end to end — written, read, and
// re-triggered on change — because closing two of the three would have
// looked fixed and still scored 0.90.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

const PREDICATE = "employees";

test("the registry declares the predicate this test is about", () => {
  const reg = src("src/entities/profile-predicates.ts");
  assert.match(reg, new RegExp(`predicate:\\s*"${PREDICATE}"`),
    "profile-predicates.ts no longer declares `employees` — pick the new canonical name and update all three sites");
});

test("something writes a headcount fact", () => {
  const writers = ["src/services/secEdgar/persist.ts", "src/entities/dualwrite.ts"];
  const writing = writers.filter((f) => new RegExp(`predicate:\\s*"${PREDICATE}"`).test(src(f)));
  assert.deepEqual(writing, writers,
    `these should each write a \`${PREDICATE}\` fact; without a writer the read below is decorative`);
});

test("the account dual-write and its backfill both carry the column", () => {
  // The insert path reads the full row, the backfill path names its columns.
  // Omitting it there left the bulk path — the one that actually populates
  // the graph — dropping headcount while the single-record path kept it.
  assert.match(src("src/entities/dualwrite.ts"), /employees\?:\s*number\s*\|\s*null/,
    "AccountLikeInput must accept employees or the dual-write silently binds null");
  const backfill = src("src/entities/backfill.ts");
  const select = backfill.match(/SELECT[\s\S]*?FROM accounts/);
  assert.ok(select, "backfillAccounts SELECT not found");
  assert.match(select[0], /\bemployees\b/,
    "backfillAccounts must select employees or the bulk path drops it");
});

test("persona matching reads the predicate that is written", () => {
  const matching = src("src/services/personaMatching.ts");
  const inList = matching.match(/predicate IN \(([^)]*)\)[^`]*value_number IS NOT NULL/);
  assert.ok(inList, "the headcount lookup in loadEmployerFacts changed shape");
  assert.ok(inList[1].includes(`'${PREDICATE}'`),
    `loadEmployerFacts asks for ${inList[1]} — none of which any writer produces, ` +
    `so scoreCompanySize returns 0 for every entity and caps every match at 0.90`);
});

test("a new headcount fact re-triggers the match", () => {
  const trigger = src("src/services/personaMatchTrigger.ts");
  const set = trigger.match(/RELEVANT_PREDICATES = new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "RELEVANT_PREDICATES not found");
  assert.ok(set[1].includes(`"${PREDICATE}"`),
    "without this a fresh headcount fact never re-scores the entity it belongs to");
});

test("company_size still carries the weight that made this matter", () => {
  const scorers = src("src/services/personaMatchingScorers.ts");
  const m = scorers.match(/company_size:\s*([0-9.]+)/);
  assert.ok(m, "company_size weight not found");
  assert.ok(Number(m[1]) > 0,
    "if company_size were zero-weighted the bug would be cosmetic; it is not");
});
