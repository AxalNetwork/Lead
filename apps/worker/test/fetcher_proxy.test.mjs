// Task #16: failover behavior of tier2Proxy across the proxy provider pool.
// We mock globalThis.fetch to make specific providers succeed/fail/throw
// and assert the loop tries each in order and succeeds on the first that
// retrieves the page. tier2Proxy touches no DB, so env is just the proxy
// secrets.

import { test } from "node:test";
import assert from "node:assert/strict";

const { tier2Proxy } = await import("../test-dist/scraper/fetcher.js");

// Big enough to clear MIN_HTML_BYTES (2048) and MIN_VISIBLE_TEXT_CHARS (400).
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

function responder(map) {
  return async (input) => {
    const u = String(input);
    for (const [frag, resp] of Object.entries(map)) {
      if (u.includes(frag)) {
        if (resp === "throw") throw new Error("ECONNREFUSED");
        return new Response(resp.body ?? "", { status: resp.status });
      }
    }
    throw new Error("unexpected proxy url: " + u);
  };
}

test("tier2Proxy: no provider configured → proxy_not_configured", async () => {
  await withMockFetch(
    async () => {
      throw new Error("fetch should not be called");
    },
    async () => {
      const r = await tier2Proxy({}, "https://example.com/p", {});
      assert.equal(r.ok, false);
      assert.equal(r.tier, 2);
      assert.equal(r.blockReason, "proxy_not_configured");
    },
  );
});

test("tier2Proxy: first provider blocked (403) → second succeeds", async () => {
  await withMockFetch(
    responder({
      "generic.proxy": { status: 403, body: "blocked" },
      "smart.proxy": { status: 200, body: OK_HTML },
    }),
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SMARTPROXY_URL: "https://smart.proxy/",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
      assert.equal(r.tier, 2);
      assert.equal(r.blockReason, null);
    },
  );
});

test("tier2Proxy: first provider throws → falls back to next", async () => {
  await withMockFetch(
    responder({
      "generic.proxy": "throw",
      "smart.proxy": { status: 200, body: OK_HTML },
    }),
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SMARTPROXY_URL: "https://smart.proxy/",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
    },
  );
});

test("tier2Proxy: all providers fail → not ok with escalatable reason", async () => {
  await withMockFetch(
    responder({
      "generic.proxy": { status: 403, body: "blocked" },
      "smart.proxy": { status: 429, body: "rate limited" },
    }),
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SMARTPROXY_URL: "https://smart.proxy/",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, false);
      assert.equal(r.tier, 2);
      // Last provider's failure is returned so the chain escalates.
      assert.equal(r.blockReason, "status_429");
    },
  );
});

test("tier2Proxy: single provider success (legacy path unchanged)", async () => {
  await withMockFetch(
    responder({ "generic.proxy": { status: 200, body: OK_HTML } }),
    async () => {
      const r = await tier2Proxy(
        { PROXY_URL: "https://generic.proxy/", PROXY_AUTH: "u:p" },
        "https://example.com/p",
        {},
      );
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
    },
  );
});
