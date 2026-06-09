// Task #70: stop crawler jobs being permanently dropped on Cloudflare's
// "Too many subrequests by single Worker invocation", and stop a single
// invocation from running past the subrequest ceiling.
//
// Three units under test:
//   1. classify() maps the subrequest-limit signal to a TRANSIENT/retryable
//      code BEFORE the generic fetch_failed → permanent rule.
//   2. SubrequestBudget spend/remaining/wouldExceed accounting.
//   3. tier2Proxy returns immediately on a subrequest-limit instead of
//      iterating the rest of the provider pool (each provider is a subrequest).

import { test } from "node:test";
import assert from "node:assert/strict";

const { classify } = await import("../test-dist/errors.js");
const { SubrequestBudget, CRAWL_SUBREQUEST_BUDGET } = await import(
  "../test-dist/scraper/subrequestBudget.js"
);
const { tier2Proxy } = await import("../test-dist/scraper/fetcher.js");

// ---------- 1. classify(): subrequest-limit is transient ----------

test("classify: 'Too many subrequests' is transient + retryable", () => {
  const r = classify("fetch_failed:proxy_error:Too many subrequests by single Worker invocation");
  assert.ok(r, "classify must recognize the subrequest-limit error");
  assert.equal(r.code, "subrequest_limit");
  assert.equal(r.kind, "transient");
  assert.equal(r.retryable, true);
});

test("classify: internal subrequest_budget marker is transient + retryable", () => {
  const r = classify("fetch_failed:subrequest_budget_exhausted");
  assert.ok(r);
  assert.equal(r.code, "subrequest_limit");
  assert.equal(r.retryable, true);
});

test("classify: subrequest rule wins over the generic fetch_failed→permanent rule", () => {
  // A plain fetch_failed (no subrequest signal) must stay non-retryable, proving
  // the subrequest branch is a genuine override and not just a blanket change.
  const generic = classify("fetch_failed:proxy_error:403 blocked");
  assert.ok(generic);
  assert.notEqual(generic.code, "subrequest_limit");
  assert.equal(generic.retryable, false);
});

// ---------- 2. SubrequestBudget accounting ----------

test("SubrequestBudget: default ceiling matches the import-path reference (700)", () => {
  assert.equal(CRAWL_SUBREQUEST_BUDGET, 700);
  const b = new SubrequestBudget();
  assert.equal(b.remaining, 700);
  assert.equal(b.used, 0);
});

test("SubrequestBudget: spend accumulates and remaining decrements", () => {
  const b = new SubrequestBudget(10);
  b.spend(3);
  b.spend(2);
  assert.equal(b.used, 5);
  assert.equal(b.remaining, 5);
});

test("SubrequestBudget: non-positive spends are ignored", () => {
  const b = new SubrequestBudget(10);
  b.spend(0);
  b.spend(-4);
  assert.equal(b.used, 0);
  assert.equal(b.remaining, 10);
});

test("SubrequestBudget: wouldExceed is true only when the next cost crosses the ceiling", () => {
  const b = new SubrequestBudget(5);
  b.spend(4);
  assert.equal(b.wouldExceed(1), false); // 4+1 == 5, still within
  assert.equal(b.wouldExceed(2), true); // 4+2 > 5
  b.spend(1); // now at the ceiling
  assert.equal(b.wouldExceed(1), true);
  assert.equal(b.remaining, 0);
});

// ---------- 3. tier2Proxy stops iterating on a subrequest-limit ----------

const OK_HTML =
  "<html><body><p>" + "real visible content word ".repeat(200) + "</p></body></html>";

function withMockFetch(fn, body) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      globalThis.fetch = orig;
    });
}

test("tier2Proxy: a 'too many subrequests' failure stops the provider loop immediately", async () => {
  let calls = 0;
  await withMockFetch(
    async (input) => {
      calls += 1;
      const u = String(input);
      if (u.includes("generic.proxy")) {
        // Cloudflare surfaces the cap as a thrown error on the outbound fetch.
        throw new Error("Too many subrequests by single Worker invocation");
      }
      if (u.includes("smart.proxy")) {
        return new Response(OK_HTML, { status: 200 });
      }
      throw new Error("unexpected proxy url: " + u);
    },
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SMARTPROXY_URL: "https://smart.proxy/",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, false);
      // The second provider must NOT be attempted — only the first fetch fired.
      assert.equal(calls, 1, "tier2Proxy must not try further providers after a subrequest-limit");
    },
  );
});

test("tier2Proxy: a normal block (403) still falls through to the next provider", async () => {
  // Control: confirms the early-return is specific to the subrequest-limit and
  // does not short-circuit ordinary failover.
  let calls = 0;
  await withMockFetch(
    async (input) => {
      calls += 1;
      const u = String(input);
      if (u.includes("generic.proxy")) return new Response("blocked", { status: 403 });
      if (u.includes("smart.proxy")) return new Response(OK_HTML, { status: 200 });
      throw new Error("unexpected proxy url: " + u);
    },
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SMARTPROXY_URL: "https://smart.proxy/",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(calls, 2, "ordinary 403 must still fail over to the second provider");
    },
  );
});

test("tier2Proxy: pre-flight budget refusal returns subrequest_budget_exhausted without fetching", async () => {
  const budget = new SubrequestBudget(0); // nothing left to spend
  await withMockFetch(
    async () => {
      throw new Error("fetch must not be called when the budget is exhausted");
    },
    async () => {
      const env = { PROXY_URL: "https://generic.proxy/" };
      const r = await tier2Proxy(env, "https://example.com/p", { budget });
      assert.equal(r.ok, false);
      assert.equal(r.blockReason, "subrequest_budget_exhausted");
    },
  );
});
