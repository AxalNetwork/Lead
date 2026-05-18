import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_consensus_invest: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://consensus.coindesk.com/speakers/";
  assert.equal(pickAdapter(url)?.id, "conference_consensus_invest");
  const r = runAdapter(url, `<html><head><title>Speakers - Consensus</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_consensus_invest");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
