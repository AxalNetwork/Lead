// Task #9: envelope sign/verify + replay-window rejection.
import { test } from "node:test";
import assert from "node:assert/strict";

import { signEnvelope, verifyEnvelope, ENVELOPE_TTL_MS } from "../../../../test-dist/services/compute/envelope.js";

test("sign + verify round-trip", async () => {
  const secret = "s3cret";
  const body = JSON.stringify({ hello: "world" });
  const env = await signEnvelope(secret, { node_id: "node_x", body });
  const r = await verifyEnvelope(secret, env, body);
  assert.equal(r.ok, true);
});

test("body tampering is rejected", async () => {
  const secret = "s3cret";
  const env = await signEnvelope(secret, { node_id: "node_x", body: "a" });
  const r = await verifyEnvelope(secret, env, "b");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "body_hash_mismatch");
});

test("wrong secret rejected", async () => {
  const env = await signEnvelope("k1", { node_id: "node_x", body: "a" });
  const r = await verifyEnvelope("k2", env, "a");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("stale envelope (>TTL) rejected", async () => {
  const secret = "s";
  const env = await signEnvelope(secret, { node_id: "node_x", body: "a" });
  const r = await verifyEnvelope(secret, env, "a", { nowMs: env.timestamp + ENVELOPE_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale_envelope");
});

test("envelope within TTL accepted", async () => {
  const secret = "s";
  const env = await signEnvelope(secret, { node_id: "node_x", body: "a" });
  const r = await verifyEnvelope(secret, env, "a", { nowMs: env.timestamp + ENVELOPE_TTL_MS - 100 });
  assert.equal(r.ok, true);
});
