// Task #5: holder normalization + parsing unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  normalizeHolderName, parseShareCount, parsePercent, parseUsd,
  classifySecurity, classifyHolder,
} = await import("../../../../test-dist/services/capTable/normalize.js");

test("normalizeHolderName strips legal + fund suffixes", () => {
  assert.equal(normalizeHolderName("Sequoia Capital, L.P."), "sequoia capital");
  assert.equal(normalizeHolderName("Andreessen Horowitz Fund III, L.P."), "andreessen horowitz fund");
  assert.equal(normalizeHolderName("Tencent Holdings Limited"), "tencent");
  assert.equal(normalizeHolderName("OMERS Capital Markets"), "omers capital");
});

test("parseShareCount handles commas + invalid markers", () => {
  assert.equal(parseShareCount("49,247,500"), 49247500);
  assert.equal(parseShareCount("3,300"), 3300);
  assert.equal(parseShareCount("—"), null);
  assert.equal(parseShareCount("*"), null);
  assert.equal(parseShareCount("n/a"), null);
});

test("parsePercent normalizes to 0..1 fractions", () => {
  assert.equal(parsePercent("29.5%"), 0.295);
  assert.equal(parsePercent("5"), 0.05);
  assert.equal(parsePercent("0.123"), 0.123);
  assert.equal(parsePercent("—"), null);
});

test("parseUsd handles K/M/B suffix", () => {
  assert.equal(parseUsd("$58.4B"), 58_400_000_000);
  assert.equal(parseUsd("100M"), 100_000_000);
  assert.equal(parseUsd("1,200,000"), 1_200_000);
});

test("classifySecurity maps Series A → preferred_a, ESOP → option", () => {
  assert.equal(classifySecurity("Series A Preferred Stock"), "preferred_a");
  assert.equal(classifySecurity("Series D"), "preferred_d");
  assert.equal(classifySecurity("Common Stock"), "common");
  assert.equal(classifySecurity("2024 ESOP Reserve"), "option");
  assert.equal(classifySecurity("SAFE"), "safe");
});

test("classifyHolder buckets fund-shaped names as preferred_investor", () => {
  assert.equal(classifyHolder("Sequoia Capital", "preferred_a"), "preferred_investor");
  assert.equal(classifyHolder("Andreessen Horowitz Fund III", "preferred_b"), "preferred_investor");
  assert.equal(classifyHolder("Steven Huffman", "common"), "founder");
  assert.equal(classifyHolder("2024 ESOP Reserve — Unallocated", "option"), "esop_unallocated");
  assert.equal(classifyHolder("2014 Equity Incentive Plan — Outstanding Options", "option"), "employee_pool");
});
