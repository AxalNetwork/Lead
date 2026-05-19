// Task #13: PII redaction tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { redactPii, prepareForLlm } = await import("../../../../test-dist/services/documents/pii.js");

test("emails are redacted with count", () => {
  const r = redactPii("contact us at hello@example.com or sales+vip@acme.co");
  assert.equal(r.counts.email, 2);
  assert.ok(!r.text.includes("@example.com"));
  assert.ok(r.text.includes("[REDACTED_EMAIL]"));
});

test("SSNs (well-formed) are redacted", () => {
  // Avoid 9xx area (ITIN range); use valid SSN-style area numbers.
  const r = redactPii("SSN 123-45-6789 and 234 56 7890");
  assert.equal(r.counts.ssn, 2);
  assert.ok(!r.text.includes("123-45-6789"));
});

test("SSN-like all-zero or 666 area is NOT redacted", () => {
  const r = redactPii("000-12-3456 and 666-12-3456");
  assert.equal(r.counts.ssn, 0);
});

test("IBAN is redacted", () => {
  const r = redactPii("Wire to DE89370400440532013000 please");
  assert.equal(r.counts.iban, 1);
});

test("credit card with valid Luhn is redacted; bad Luhn is not", () => {
  const r1 = redactPii("Card 4242 4242 4242 4242 for charge");
  assert.equal(r1.counts.credit_card, 1);
  const r2 = redactPii("Order 1234 5678 9012 3456 confirmed");
  assert.equal(r2.counts.credit_card, 0);
});

test("US bank account near 'account' keyword is redacted", () => {
  const r = redactPii("account: 0012345678 routing: 021000021");
  assert.ok(r.counts.us_bank_account >= 1);
});

test("phone numbers are redacted", () => {
  const r = redactPii("Call 415-555-1234 or +1 (212) 555-0100 today");
  assert.ok(r.counts.phone >= 2);
});

test("prepareForLlm honors allowRaw=true with zero redaction", () => {
  const original = "email me at user@example.com";
  const r = prepareForLlm(original, true);
  assert.equal(r.text, original);
  assert.equal(r.total, 0);
});

test("prepareForLlm with allowRaw=false redacts everything", () => {
  const r = prepareForLlm("user@x.com and 415-555-1234", false);
  assert.ok(r.total >= 2);
  assert.ok(!r.text.includes("user@x.com"));
});
