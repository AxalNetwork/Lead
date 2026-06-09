// Task #52: behavioral test for the AI Search store's failure signal.
// indexEntity must return false ONLY when a configured live AI_SEARCH write
// is attempted and fails — that false is what lets EntityLock flag a durable
// reconcile. Proves the "simulated downstream failure is observable" leg of
// the merge-consistency contract without a full DO harness.

import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../test-dist/ai/search_sync.js");
const { indexEntity } = mod;

const DOC = { id: "e1", type: "lead", title: "Acme", body: "Acme — VC" };

function makeEnv({ aiSearch, dbThrows = false } = {}) {
  const calls = { fetch: 0, insert: 0 };
  return {
    calls,
    env: {
      AI_SEARCH: aiSearch === "none" ? undefined : {
        fetch: async () => {
          calls.fetch++;
          if (aiSearch === "throw") throw new Error("ai-search outage");
          if (aiSearch === "notok") return { ok: false, status: 500 };
          return { ok: true };
        },
      },
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              calls.insert++;
              if (dbThrows) throw new Error("no such table: ai_search_pending");
            },
          }),
        }),
      },
    },
  };
}

test("live AI Search write succeeds → returns true, no pending fallback", async () => {
  const { env, calls } = makeEnv({ aiSearch: "ok" });
  const ok = await indexEntity(env, DOC);
  assert.equal(ok, true);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.insert, 0);
});

test("live AI Search write fails → returns false (divergence signal) + queues backfill", async () => {
  const { env, calls } = makeEnv({ aiSearch: "throw" });
  const ok = await indexEntity(env, DOC);
  assert.equal(ok, false);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.insert, 1);
});

test("live AI Search non-2xx response → returns false (divergence signal) + queues backfill", async () => {
  const { env, calls } = makeEnv({ aiSearch: "notok" });
  const ok = await indexEntity(env, DOC);
  assert.equal(ok, false);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.insert, 1);
});

test("live failure AND pending insert failure → still returns false (reconcilable)", async () => {
  const { env, calls } = makeEnv({ aiSearch: "throw", dbThrows: true });
  const ok = await indexEntity(env, DOC);
  assert.equal(ok, false);
  assert.equal(calls.insert, 1);
});

test("no AI_SEARCH binding → deferral is the designed state, returns true", async () => {
  const { env, calls } = makeEnv({ aiSearch: "none" });
  const ok = await indexEntity(env, DOC);
  assert.equal(ok, true);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.insert, 1);
});
