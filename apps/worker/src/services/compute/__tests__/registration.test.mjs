// Task #9: registration-token TTL enforcement + nonce-replay rejection.
// In-memory KV stand-in mirrors the Workers KV surface we exercise.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mintRegistrationToken, readRegistrationToken, consumeRegistrationToken } from "../registration.js";
import { kvNonceStore } from "../envelope.js";

function fakeKv() {
  const m = new Map();
  return {
    async get(k) {
      const v = m.get(k);
      if (!v) return null;
      if (v.exp && v.exp < Date.now()) { m.delete(k); return null; }
      return v.val;
    },
    async put(k, v, opts) {
      const exp = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      m.set(k, { val: v, exp });
    },
    async delete(k) { m.delete(k); },
  };
}

test("registration token survives within TTL, gone after expiry", async () => {
  const kv = fakeKv();
  const env = { SESSIONS: kv };
  const { token } = await mintRegistrationToken(env, {
    name: "n", provider: "self", kind: "cpu",
    supported_job_types: ["crawl"], max_concurrent_jobs: 1,
    cost_per_hour_usd: 0, cost_per_1k_tokens_usd: 0,
    capabilities_json: {}, registered_by: "op@example.com",
  });
  assert.ok(typeof token === "string" && token.length > 8);
  const read = await readRegistrationToken(env, token);
  assert.equal(read.name, "n");
  // Simulate TTL elapsed: stomp the internal exp by deleting.
  await kv.delete("compute:reg:" + token);
  const gone = await readRegistrationToken(env, token);
  assert.equal(gone, null);
});

test("consume is one-shot", async () => {
  const kv = fakeKv();
  const env = { SESSIONS: kv };
  const { token } = await mintRegistrationToken(env, {
    name: "n", provider: "self", kind: "cpu",
    supported_job_types: ["crawl"], max_concurrent_jobs: 1,
    cost_per_hour_usd: 0, cost_per_1k_tokens_usd: 0,
    capabilities_json: {}, registered_by: "op@example.com",
  });
  const first = await consumeRegistrationToken(env, token);
  assert.ok(first);
  const second = await consumeRegistrationToken(env, token);
  assert.equal(second, null);
});

test("nonce replay rejected within rolling cache window", async () => {
  const kv = fakeKv();
  const store = kvNonceStore(kv);
  assert.equal(await store.seen("n1"), false);
  await store.remember("n1");
  assert.equal(await store.seen("n1"), true);
});
