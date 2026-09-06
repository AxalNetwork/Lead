// A buyer-signal source with nothing to scan looked exactly like one that
// scanned everything and found nothing new.
//
// The seven ATS sources (greenhouse, lever, ashby, workable, recruitee,
// personio, smartrecruiters) each read an operator-set key off
// accounts.meta_json — greenhouse_board, lever_company, ashby_company,
// workable_account, recruitee_company, personio_company,
// smartrecruiters_company. Nothing in the worker sets any of them
// automatically, so on a fresh deployment every one of those SELECTs returns
// zero rows and the run records `0 emitted, ok`. Identical to a healthy run.
//
// Two things were wrong, and fixing either alone leaves the operator blind:
//
//   * The sources reported no counters at all.
//   * CrawlResult.meta is documented as "per-source counters appended to
//     crawler_runs.meta_json", and the column has existed since migration
//     161 — but runCrawl.ts never read the field and its UPDATE never wrote
//     the column, so any counters a source did return were discarded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

const ATS = [
  "greenhouse", "lever", "ashby", "workable",
  "recruitee", "personio", "smartrecruiters",
];

test("all seven ATS sources are still present", () => {
  const files = readdirSync(join(ROOT, "src/prospects/sources"));
  for (const s of ATS) assert.ok(files.includes(`${s}.ts`), `${s}.ts missing`);
});

test("every ATS source reports how much it had to scan", () => {
  const missing = ATS.filter((s) => {
    const f = src(`src/prospects/sources/${s}.ts`);
    return !/meta:\s*\{[^}]*seeded_accounts/.test(f);
  });
  assert.deepEqual(missing, [],
    `these report no counters, so "nothing seeded" and "nothing new" are the ` +
    `same run row: ${missing.join(", ")}`);
});

test("the counters are derived, not hardcoded", () => {
  // A literal `seeded_accounts: 0` would satisfy the check above and tell an
  // operator nothing.
  for (const s of ATS) {
    const f = src(`src/prospects/sources/${s}.ts`);
    assert.match(f, /let seeded = 0, boardsFetched = 0;/, `${s}: counters not declared`);
    assert.match(f, /\bseeded \+= 1;/, `${s}: seeded is never incremented`);
    assert.match(f, /\bboardsFetched \+= 1;/, `${s}: boardsFetched is never incremented`);
  }
});

test("runCrawl persists the meta it is handed", () => {
  const f = src("src/prospects/runCrawl.ts");
  assert.match(f, /crawlMeta = r\.meta;/,
    "runCrawl must read CrawlResult.meta — the field was documented and ignored");
  assert.match(f, /UPDATE crawler_runs SET[^`]*meta_json = \?/,
    "the finalize UPDATE must write meta_json or the counters are dropped on the floor");
});

test("the crawler_runs column the counters land in exists", () => {
  const dir = join(ROOT, "migrations");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const block = sql.match(/CREATE TABLE IF NOT EXISTS crawler_runs\s*\(([\s\S]*?)\n\);/);
  assert.ok(block, "crawler_runs not found in the migrations");
  assert.match(block[1], /\bmeta_json\b/, "crawler_runs has no meta_json column");
});

test("the crawlers console renders the counters", () => {
  const page = readFileSync(join(ROOT, "../site/dashboard/crawlers.html"), "utf8");
  assert.match(page, /function runNotes\(/,
    "meta_json reaches the client via SELECT * but nothing rendered it");
  assert.match(page, /runNotes\(x\.meta_json\)/, "runNotes is defined but not called");
});
