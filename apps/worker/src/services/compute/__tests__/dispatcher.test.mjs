// Task #9: dispatcher ranking + fallback chain.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickNodeFromList, HEARTBEAT_FRESH_MS } from "../dispatcher.js";

function node(over) {
  return {
    id: "node_a", name: "a", provider: "self", kind: "gpu",
    endpoint_url: null, auth_secret_kv_key: "k",
    supported_job_types: JSON.stringify(["vision_ocr", "llm_classify"]),
    capabilities_json: "{}",
    max_concurrent_jobs: 4, current_active_jobs: 0,
    cost_per_hour_usd: 0.4, cost_per_1k_tokens_usd: 0,
    enabled: 1, drain: 0,
    last_heartbeat_at: new Date().toISOString(),
    last_error: null,
    ...over,
  };
}

test("picks cheapest eligible node", () => {
  const cheap = node({ id: "cheap", name: "cheap", cost_per_hour_usd: 0.1 });
  const dear = node({ id: "dear", name: "dear", cost_per_hour_usd: 1.0 });
  const r = pickNodeFromList("vision_ocr", 100, [dear, cheap]);
  assert.equal(r.id, "cheap");
});

test("filters by enabled", () => {
  const dis = node({ id: "dis", enabled: 0 });
  const ok = node({ id: "ok" });
  assert.equal(pickNodeFromList("vision_ocr", 1, [dis, ok]).id, "ok");
});

test("filters by drain", () => {
  const dr = node({ id: "dr", drain: 1, cost_per_hour_usd: 0.1 });
  const ok = node({ id: "ok", cost_per_hour_usd: 1.0 });
  assert.equal(pickNodeFromList("vision_ocr", 1, [dr, ok]).id, "ok");
});

test("filters by stale heartbeat", () => {
  const stale = node({ id: "stale", last_heartbeat_at: new Date(Date.now() - HEARTBEAT_FRESH_MS - 1000).toISOString() });
  const fresh = node({ id: "fresh" });
  assert.equal(pickNodeFromList("vision_ocr", 1, [stale, fresh]).id, "fresh");
});

test("filters by supported_job_types", () => {
  const wrong = node({ id: "wrong", supported_job_types: JSON.stringify(["crawl"]) });
  const right = node({ id: "right" });
  assert.equal(pickNodeFromList("vision_ocr", 1, [wrong, right]).id, "right");
});

test("filters by saturation", () => {
  const full = node({ id: "full", current_active_jobs: 4, max_concurrent_jobs: 4 });
  const room = node({ id: "room", cost_per_hour_usd: 1.0 });
  assert.equal(pickNodeFromList("vision_ocr", 1, [full, room]).id, "room");
});

test("returns null when nothing fits → caller falls back", () => {
  assert.equal(pickNodeFromList("vision_ocr", 1, []), null);
  const all_bad = [node({ enabled: 0 }), node({ drain: 1 })];
  assert.equal(pickNodeFromList("vision_ocr", 1, all_bad), null);
});

test("kind preference tiebreak (gpu before cpu for gpu-preferred jobs)", () => {
  const cpu = node({ id: "cpu", kind: "cpu", cost_per_hour_usd: 0.5 });
  const gpu = node({ id: "gpu", kind: "gpu", cost_per_hour_usd: 0.5 });
  assert.equal(pickNodeFromList("vision_ocr", 1, [cpu, gpu]).id, "gpu");
});
