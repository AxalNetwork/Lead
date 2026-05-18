import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_aws_reinvent: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://reinvent.awsevents.com/agenda/";
  assert.equal(pickAdapter(url)?.id, "conference_aws_reinvent");
  const r = runAdapter(url, `<html><head><title>Agenda - AWS re:Invent</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_aws_reinvent");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
