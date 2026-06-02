// Task #16: unit tests for the proxy provider list helper. Pure logic —
// no DB, no network. Verifies provider-list construction from various env
// combinations and the "any proxy configured" predicate.

import { test } from "node:test";
import assert from "node:assert/strict";

const { getProxyProviders, hasAnyProxy } = await import(
  "../test-dist/scraper/proxyPool.js"
);

test("getProxyProviders: empty env → no providers", () => {
  assert.deepEqual(getProxyProviders({}), []);
  assert.equal(hasAnyProxy({}), false);
});

test("getProxyProviders: only legacy PROXY_URL → generic provider", () => {
  const list = getProxyProviders({ PROXY_URL: "https://p/", PROXY_AUTH: "u:p" });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { name: "generic", url: "https://p/", auth: "u:p" });
  assert.equal(hasAnyProxy({ PROXY_URL: "https://p/" }), true);
});

test("getProxyProviders: only a non-legacy provider is enough", () => {
  const list = getProxyProviders({ SMARTPROXY_URL: "https://smart/" });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "smartproxy");
  assert.equal(list[0].url, "https://smart/");
  assert.equal(list[0].auth, undefined);
  assert.equal(hasAnyProxy({ OXYLABS_URL: "https://ox/" }), true);
});

test("getProxyProviders: auth omitted when unset", () => {
  const list = getProxyProviders({ BRIGHTDATA_URL: "https://bd/" });
  assert.equal(list.length, 1);
  assert.ok(!("auth" in list[0]), "auth should be absent when not configured");
});

test("getProxyProviders: url-less auth secret does NOT create a provider", () => {
  assert.deepEqual(getProxyProviders({ SMARTPROXY_AUTH: "u:p" }), []);
});

test("getProxyProviders: fixed order generic → smartproxy → brightdata → oxylabs", () => {
  const list = getProxyProviders({
    OXYLABS_URL: "https://ox/",
    BRIGHTDATA_URL: "https://bd/",
    SMARTPROXY_URL: "https://smart/",
    PROXY_URL: "https://generic/",
  });
  assert.deepEqual(
    list.map((p) => p.name),
    ["generic", "smartproxy", "brightdata", "oxylabs"],
  );
});

test("getProxyProviders: skips absent slots while preserving order", () => {
  const list = getProxyProviders({
    OXYLABS_URL: "https://ox/",
    SMARTPROXY_URL: "https://smart/",
  });
  assert.deepEqual(
    list.map((p) => p.name),
    ["smartproxy", "oxylabs"],
  );
});
