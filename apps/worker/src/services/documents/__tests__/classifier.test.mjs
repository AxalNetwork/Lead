// Task #13: Document classifier tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyDocument } = await import("../../../../test-dist/services/documents/classifier.js");

test("filename:safe wins", () => {
  const r = classifyDocument({ filename: "SAFE-2024.pdf", mime: "application/pdf", sampleText: "" });
  assert.equal(r.kind, "safe");
  assert.ok(r.confidence >= 0.85);
});

test("filename:term_sheet wins", () => {
  const r = classifyDocument({ filename: "Term-Sheet-Series-A.pdf", mime: "application/pdf", sampleText: "" });
  assert.equal(r.kind, "term_sheet");
});

test("xlsx mime classifies as financial_model", () => {
  const r = classifyDocument({ filename: "data.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sampleText: "" });
  assert.equal(r.kind, "financial_model");
});

test("pptx classifies as pitch_deck", () => {
  const r = classifyDocument({ filename: "presentation.pptx", mime: "", sampleText: "" });
  assert.equal(r.kind, "pitch_deck");
});

test("keyword density picks NDA when filename is opaque", () => {
  const r = classifyDocument({
    filename: "agreement_2024.pdf", mime: "application/pdf",
    sampleText: "This mutual non-disclosure agreement governs the confidential information exchanged. Nondisclosure obligations survive.",
  });
  assert.equal(r.kind, "nda");
});

test("keyword density picks shareholder_agreement", () => {
  const r = classifyDocument({
    filename: "agreement.pdf", mime: "application/pdf",
    sampleText: "Shareholders agreement with drag-along and tag-along provisions plus right of first refusal and preemptive rights.",
  });
  assert.equal(r.kind, "shareholder_agreement");
});

test("no signal => unknown", () => {
  const r = classifyDocument({ filename: "doc.pdf", mime: "application/pdf", sampleText: "" });
  assert.equal(r.kind, "unknown");
});
