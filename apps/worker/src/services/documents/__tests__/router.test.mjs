// Task #13: extractor router + redaction interaction.

import { test } from "node:test";
import assert from "node:assert/strict";

const { runExtractor } = await import("../../../../test-dist/services/documents/extractorRouter.js");
const { categorizeForDataRoom } = await import("../../../../test-dist/services/documents/persist.js");

test("router: SAFE routes to safeParser, applies redaction by default", () => {
  const text = "POST-MONEY SAFE. Investor: hello@example.com. Valuation Cap: $10M.";
  const r = runExtractor({ kind: "safe", text, allowRawText: false });
  assert.equal(r.extractor_name, "safeParser");
  assert.equal(r.redaction_applied, true);
  assert.equal(r.redaction_counts.email, 1);
  // SAFE business fields still extract from the redacted text.
  assert.equal(r.payload.valuation_cap_usd, 10_000_000);
});

test("router: allowRawText=true skips redaction", () => {
  const r = runExtractor({ kind: "safe", text: "Valuation Cap: $5M email user@x.com", allowRawText: true });
  assert.equal(r.redaction_applied, false);
  assert.equal(r.redaction_counts, null);
});

test("router: unknown kind returns noop with low confidence", () => {
  const r = runExtractor({ kind: "unknown", text: "anything", allowRawText: false });
  assert.equal(r.extractor_name, "noop");
  assert.ok(r.confidence < 0.5);
});

test("categorizeForDataRoom: kind-based categories", () => {
  assert.equal(categorizeForDataRoom("safe", "x.pdf"), "corporate");
  assert.equal(categorizeForDataRoom("financial_model", "x.xlsx"), "financial");
  assert.equal(categorizeForDataRoom("commercial_contract", "x.pdf"), "customer");
  assert.equal(categorizeForDataRoom("nda", "Employee_NDA.pdf"), "employment");
  assert.equal(categorizeForDataRoom("nda", "Vendor_NDA.pdf"), "regulatory");
  assert.equal(categorizeForDataRoom("unknown", "patent-filing.pdf"), "ip");
  assert.equal(categorizeForDataRoom("unknown", "offer_letter.pdf"), "employment");
  assert.equal(categorizeForDataRoom("unknown", "misc.pdf"), "other");
});
