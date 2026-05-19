// Task #5: S-1 cap-table extractor unit tests.
// Spec acceptance probe: >95% holder name accuracy on a real S-1
// "Principal Stockholders" table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { extractS1CapTable } = await import("../../../../test-dist/services/capTable/s1CapTableParser.js");

const REDDIT_HTML = await readFile(join(__dirname, "fixtures", "reddit-s1-principal-stockholders.html"), "utf8");

test("Reddit S-1: extracts Principal Stockholders table", () => {
  const r = extractS1CapTable(REDDIT_HTML);
  assert.equal(r.ok, true, `expected ok extraction, got reason=${r.reason}`);
  assert.ok(r.holders.length >= 10, `expected >=10 holders, got ${r.holders.length}`);
});

test("Reddit S-1: known top holders are recovered (>95% name accuracy)", () => {
  const r = extractS1CapTable(REDDIT_HTML);
  const names = r.holders.map((h) => h.holder_name_raw);
  // Spec calls out the famous Reddit holders. All 8 must appear.
  const required = [
    "Advance Magazine Publishers Inc.",
    "Tencent Holdings Limited",
    "Quiet Capital",
    "OMERS Capital Markets",
    "Vy Capital",
    "Sequoia Capital",
    "Andreessen Horowitz Fund III, L.P.",
    "Steven Huffman",
  ];
  let found = 0;
  for (const want of required) {
    if (names.some((n) => n.includes(want.split(",")[0]) || n.includes(want.split(" ")[0]))) found++;
  }
  const accuracy = found / required.length;
  assert.ok(accuracy >= 0.95, `holder name accuracy ${(accuracy*100).toFixed(0)}% < 95% (found ${found}/${required.length})`);
});

test("Reddit S-1: parses share counts and percentages", () => {
  const r = extractS1CapTable(REDDIT_HTML);
  const advance = r.holders.find((h) => h.holder_name_raw.startsWith("Advance"));
  assert.ok(advance, "Advance Magazine Publishers row missing");
  assert.equal(advance.shares, 49247500);
  assert.ok(advance.pct_ownership != null && advance.pct_ownership > 0.29 && advance.pct_ownership < 0.30,
    `Advance pct expected ~0.295, got ${advance.pct_ownership}`);
});

test("Reddit S-1: total row is captured separately, not as a holder", () => {
  const r = extractS1CapTable(REDDIT_HTML);
  const totalRow = r.holders.find((h) => /^total$/i.test(h.holder_name_raw));
  assert.equal(totalRow, undefined, "Total row should be filtered out of holders");
  assert.equal(r.totals.shares, 167_000_000);
});

test("Reddit S-1: founder vs preferred-investor classification", () => {
  const r = extractS1CapTable(REDDIT_HTML);
  const huffman = r.holders.find((h) => h.holder_name_raw.includes("Huffman"));
  assert.ok(huffman, "Huffman row missing");
  assert.equal(huffman.holder_class, "founder",
    `Steven Huffman should classify as founder, got ${huffman.holder_class}`);
  const sequoia = r.holders.find((h) => h.holder_name_raw.includes("Sequoia"));
  assert.ok(sequoia, "Sequoia row missing");
  assert.equal(sequoia.holder_class, "preferred_investor",
    `Sequoia should classify as preferred_investor, got ${sequoia.holder_class}`);
});

test("extractor returns ok=false when the page has no Principal Stockholders table", () => {
  const r = extractS1CapTable("<html><body><p>Hello world</p></body></html>");
  assert.equal(r.ok, false);
  assert.equal(r.holders.length, 0);
});
