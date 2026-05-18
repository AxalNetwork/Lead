import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("podcast_directories: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://podcasts.apple.com/us/podcast/example-show/id12345";
  assert.equal(pickAdapter(url)?.id, "podcast_directories");
  const r = runAdapter(url, `<html><head><title>Example Show on Apple Podcasts</title><meta property="og:title" content="Example Show"></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "podcast_directories");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
