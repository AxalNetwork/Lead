// Task #8 regression tests: (a) second promotion for the same
// prompt_key must succeed (uq_prompt_versions_active is a partial
// unique index over active=1 rows, so the deactivate-old step must
// run BEFORE the insert-new step); (b) production-eval prompt-key
// map must match the colon-form constants the runtime call sites
// use, otherwise eval evaluates a different prompt than production.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("promotePrompt batch deactivates old before inserting new (D1 partial-unique-index safe)", () => {
  const src = readFileSync(join(HERE, "..", "prompts.ts"), "utf8");
  const batchIdx = src.indexOf("env.DB.batch([");
  assert.ok(batchIdx > -1, "promotePrompt should use env.DB.batch");
  const block = src.slice(batchIdx, batchIdx + 800);
  const updateIdx = block.indexOf("UPDATE prompt_versions SET active = 0");
  const insertIdx = block.indexOf("INSERT INTO prompt_versions");
  assert.ok(updateIdx > -1, "must deactivate prior active row");
  assert.ok(insertIdx > -1, "must insert new active row");
  assert.ok(updateIdx < insertIdx,
    "UPDATE active=0 must run BEFORE INSERT active=1 to avoid uq_prompt_versions_active violation on second promotion");
});

test("production-eval prompt keys match runtime call-site constants (colon form)", () => {
  const dealSrc = readFileSync(join(HERE, "..", "..", "..", "ai", "dealExtractor.ts"), "utf8");
  const pageSrc = readFileSync(join(HERE, "..", "..", "pageClassifier.ts"), "utf8");
  const dealKey = (dealSrc.match(/DEAL_EXTRACTOR_PROMPT_KEY\s*=\s*"([^"]+)"/) || [])[1];
  const pageKey = (pageSrc.match(/PAGE_CLASS_PROMPT_KEY\s*=\s*"([^"]+)"/) || [])[1];
  assert.equal(dealKey, "deal_extractor:v1");
  assert.equal(pageKey, "page_classifier:v1");

  const llmSrc = readFileSync(join(HERE, "..", "llmPredictors.ts"), "utf8");
  const routeSrc = readFileSync(join(HERE, "..", "..", "..", "routes", "ml.ts"), "utf8");
  for (const f of [llmSrc, routeSrc]) {
    assert.ok(f.includes(`"deal_extractor:v1"`),
      "eval map must use the same colon-form key as the runtime call site");
    assert.ok(f.includes(`"page_classifier:v1"`),
      "eval map must use the same colon-form key as the runtime call site");
    assert.ok(!/"deal_extractor\.v1"|"page_classifier\.v1"/.test(f),
      "dot-form keys are stale — must not appear in eval modules");
  }
});
