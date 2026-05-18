// Task #3: dedupe key + source-authority unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  normalizeCompanyName, normalizeRoundName, monthBucket,
  dealDedupeKey, hasHardConflict, isHigherAuthority, sourceAuthorityRank,
} = await import("../../../../test-dist/services/deals/dedupe.js");

test("normalizeCompanyName strips legal suffixes + lowercases", () => {
  assert.equal(normalizeCompanyName("Acme Inc."), "acme");
  assert.equal(normalizeCompanyName("The Acme Corporation"), "acme");
  assert.equal(normalizeCompanyName("Acme, LLC"), "acme");
  assert.equal(normalizeCompanyName("Acme (Delaware) Inc."), "acme");
  assert.equal(normalizeCompanyName("23andMe Holding Co."), "23andme holding");
});

test("normalizeRoundName collapses casing + 'round' suffix", () => {
  assert.equal(normalizeRoundName("Series A"), "series a");
  assert.equal(normalizeRoundName("series a"), "series a");
  assert.equal(normalizeRoundName("Series A Round"), "series a");
  assert.equal(normalizeRoundName(null), "");
});

test("monthBucket extracts YYYY-MM from announcement OR closing date", () => {
  assert.equal(monthBucket("2025-05-12", null), "2025-05");
  assert.equal(monthBucket(null, "2025-05-12"), "2025-05");
  assert.equal(monthBucket(null, null), "");
});

test("dealDedupeKey collapses spelling + date variations within a month", async () => {
  const a = await dealDedupeKey({
    company_name_raw: "Acme Inc.", round_name: "Series B",
    announcement_date: "2025-05-12", closing_date: null,
  });
  const b = await dealDedupeKey({
    company_name_raw: "Acme, LLC", round_name: "series b",
    announcement_date: "2025-05-28", closing_date: null,
  });
  assert.ok(a && b);
  assert.equal(a, b, "same company + round + month bucket must yield same key");
});

test("dealDedupeKey differs across months (no over-collapse)", async () => {
  const a = await dealDedupeKey({
    company_name_raw: "Acme", round_name: "Series B",
    announcement_date: "2025-05-12", closing_date: null,
  });
  const c = await dealDedupeKey({
    company_name_raw: "Acme", round_name: "Series B",
    announcement_date: "2025-09-12", closing_date: null,
  });
  assert.notEqual(a, c);
});

test("dealDedupeKey returns null on missing date", async () => {
  const k = await dealDedupeKey({
    company_name_raw: "Acme", round_name: "Series B",
    announcement_date: null, closing_date: null,
  });
  assert.equal(k, null);
});

test("sourceAuthorityRank ordering: SEC > company_blog > press_release > tech_press", () => {
  assert.ok(sourceAuthorityRank("sec_filing") > sourceAuthorityRank("company_blog"));
  assert.ok(sourceAuthorityRank("company_blog") > sourceAuthorityRank("press_release"));
  assert.ok(sourceAuthorityRank("press_release") > sourceAuthorityRank("tech_press"));
  assert.ok(isHigherAuthority("sec_filing", "tech_press"));
  assert.ok(!isHigherAuthority("tech_press", "sec_filing"));
});

test("hasHardConflict: amounts within 5% are NOT a conflict", () => {
  assert.equal(hasHardConflict(
    { amount_usd: 40_000_000, announcement_date: "2025-05-12" },
    { amount_usd: 41_500_000, announcement_date: "2025-05-13" },
  ), false);
});

test("hasHardConflict: amounts diverging > 5% IS a conflict", () => {
  assert.equal(hasHardConflict(
    { amount_usd: 40_000_000, announcement_date: "2025-05-12" },
    { amount_usd: 80_000_000, announcement_date: "2025-05-12" },
  ), true);
});

test("hasHardConflict: announcement dates > 14 days apart IS a conflict", () => {
  assert.equal(hasHardConflict(
    { amount_usd: 40_000_000, announcement_date: "2025-05-01" },
    { amount_usd: 40_000_000, announcement_date: "2025-05-25" },
  ), true);
});
