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

test("getProxyProviders: fixed order forward then API (Task #39)", () => {
  const list = getProxyProviders({
    SCRAPESTACK_KEY: "ss-key",
    SCRAPERAPI_KEY: "sa-key",
    OXYLABS_URL: "https://ox/",
    BRIGHTDATA_URL: "https://bd/",
    SMARTPROXY_URL: "https://smart/",
    PROXY_URL: "https://generic/",
  });
  assert.deepEqual(
    list.map((p) => p.name),
    ["generic", "smartproxy", "brightdata", "oxylabs", "scraperapi", "scrapestack"],
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

// --- Task #39: API-mode providers (ScraperAPI, scrapestack) ---

test("getProxyProviders: ScraperAPI active only when SCRAPERAPI_KEY set", () => {
  assert.deepEqual(getProxyProviders({ SCRAPERAPI_COUNTRY: "us" }), []);
  const list = getProxyProviders({ SCRAPERAPI_KEY: "sa-key" });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "scraperapi");
  assert.equal(list[0].mode, "api");
  assert.ok(!("auth" in list[0]), "API-mode provider carries no auth");
  assert.equal(list[0].url, "https://api.scraperapi.com/?api_key=sa-key");
});

test("getProxyProviders: ScraperAPI bakes country_code when set, key URL-encoded", () => {
  const list = getProxyProviders({ SCRAPERAPI_KEY: "a b/c", SCRAPERAPI_COUNTRY: "us" });
  assert.equal(
    list[0].url,
    "https://api.scraperapi.com/?api_key=a%20b%2Fc&country_code=us",
  );
});

test("getProxyProviders: scrapestack active only when SCRAPESTACK_KEY set", () => {
  assert.deepEqual(getProxyProviders({ SCRAPESTACK_COUNTRY: "us" }), []);
  const list = getProxyProviders({ SCRAPESTACK_KEY: "ss-key" });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "scrapestack");
  assert.equal(list[0].mode, "api");
  assert.ok(!("auth" in list[0]), "API-mode provider carries no auth");
  assert.equal(list[0].url, "https://api.scrapestack.com/scrape?access_key=ss-key");
});

test("getProxyProviders: scrapestack bakes proxy_location when set", () => {
  const list = getProxyProviders({ SCRAPESTACK_KEY: "ss-key", SCRAPESTACK_COUNTRY: "de" });
  assert.equal(
    list[0].url,
    "https://api.scrapestack.com/scrape?access_key=ss-key&proxy_location=de",
  );
});
