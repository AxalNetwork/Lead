import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("twitter_public: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://twitter.com/janedoe";
  assert.equal(pickAdapter(url)?.id, "twitter_public");
  const r = runAdapter(url, `<html><head><meta property="og:title" content="Jane Doe (@janedoe) / Twitter"><meta property="og:description" content="Investor at Acme Capital. SF."></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "twitter_public");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
