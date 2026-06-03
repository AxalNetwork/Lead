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

// --- Task #39: re-verify the existing forward vendors on the shared path ---

test("tier2Proxy: Bright Data forward slot fetches with Basic auth", async () => {
  let authHeader = null;
  let calledUrl = null;
  await withMockFetch(
    async (input, init) => {
      calledUrl = String(input);
      authHeader = new Headers(init?.headers).get("authorization");
      return new Response(OK_HTML, { status: 200 });
    },
    async () => {
      const r = await tier2Proxy(
        { BRIGHTDATA_URL: "https://bd.proxy/", BRIGHTDATA_AUTH: "u:p" },
        "https://example.com/p",
        {},
      );
      assert.equal(r.ok, true);
      assert.ok(calledUrl.startsWith("https://bd.proxy/?url="), calledUrl);
      assert.equal(authHeader, "Basic " + btoa("u:p"));
    },
  );
});

test("tier2Proxy: Oxylabs forward slot fetches (auth optional, none sent when unset)", async () => {
  let authHeader = "unset";
  await withMockFetch(
    async (input, init) => {
      authHeader = new Headers(init?.headers).get("authorization");
      return new Response(OK_HTML, { status: 200 });
    },
    async () => {
      const r = await tier2Proxy({ OXYLABS_URL: "https://ox.proxy/" }, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(authHeader, null, "no Authorization header when OXYLABS_AUTH unset");
    },
  );
});

// --- Task #39: API-mode providers escalate after the forward proxies ---

test("tier2Proxy: forward provider blocked → escalates into ScraperAPI", async () => {
  let scraperApiUrl = null;
  await withMockFetch(
    async (input) => {
      const u = String(input);
      if (u.includes("api.scraperapi.com")) {
        scraperApiUrl = u;
        return new Response(OK_HTML, { status: 200 });
      }
      if (u.includes("generic.proxy")) return new Response("blocked", { status: 403 });
      throw new Error("unexpected url: " + u);
    },
    async () => {
      const env = {
        PROXY_URL: "https://generic.proxy/",
        SCRAPERAPI_KEY: "sa-key",
      };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
      // Target appended as url= param and key kept in the API base URL.
      assert.ok(
        scraperApiUrl.startsWith("https://api.scraperapi.com/?api_key=sa-key&url="),
        "ScraperAPI base URL preserved with target appended: " + scraperApiUrl,
      );
      assert.ok(
        scraperApiUrl.includes(encodeURIComponent("https://example.com/p")),
        "target URL is URL-encoded into the url= param",
      );
    },
  );
});

test("tier2Proxy: API providers send no Authorization header", async () => {
  let sawAuthHeader = false;
  await withMockFetch(
    async (input, init) => {
      const u = String(input);
      if (u.includes("api.scrapestack.com")) {
        const h = new Headers(init?.headers);
        if (h.has("authorization")) sawAuthHeader = true;
        return new Response(OK_HTML, { status: 200 });
      }
      throw new Error("unexpected url: " + u);
    },
    async () => {
      const r = await tier2Proxy({ SCRAPESTACK_KEY: "ss-key" }, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(sawAuthHeader, false, "no Authorization header for API-mode proxy");
    },
  );
});

test("tier2Proxy: ScraperAPI fails → escalates to scrapestack", async () => {
  await withMockFetch(
    responder({
      "api.scraperapi.com": { status: 500, body: "err" },
      "api.scrapestack.com": { status: 200, body: OK_HTML },
    }),
    async () => {
      const env = { SCRAPERAPI_KEY: "sa-key", SCRAPESTACK_KEY: "ss-key" };
      const r = await tier2Proxy(env, "https://example.com/p", {});
      assert.equal(r.ok, true);
      assert.equal(r.status, 200);
    },
  );
});
