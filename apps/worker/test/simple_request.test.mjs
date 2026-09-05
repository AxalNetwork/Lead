// CORS-simple tunnel: the Worker must reverse the dashboard's
// POST + ?_method= / ?_idempotency_key= rewrite before routing, and must
// never upgrade anything other than a POST.
import { test } from "node:test";
import assert from "node:assert/strict";

const { unwrapSimpleRequest, METHOD_OVERRIDE_PARAM, IDEMPOTENCY_KEY_PARAM } =
  await import("../test-dist/middleware/simple_request.js");

const BASE = "https://api.aidatasignal.com";

test("POST + _method=DELETE becomes a DELETE with the param stripped and body kept", async () => {
  const req = new Request(`${BASE}/api/personas/p1?${METHOD_OVERRIDE_PARAM}=DELETE&keep=1`, {
    method: "POST",
    body: JSON.stringify({ reason: "dup" }),
    headers: { Cookie: "CF_Authorization=abc" },
  });
  const out = unwrapSimpleRequest(req);
  assert.equal(out.method, "DELETE");
  const url = new URL(out.url);
  assert.equal(url.pathname, "/api/personas/p1");
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.searchParams.has(METHOD_OVERRIDE_PARAM), false);
  assert.equal(out.headers.get("Cookie"), "CF_Authorization=abc");
  assert.deepEqual(await out.json(), { reason: "dup" });
});

test("lower-case verbs are normalised; PUT and PATCH are both supported", () => {
  for (const [given, want] of [["put", "PUT"], ["Patch", "PATCH"]]) {
    const out = unwrapSimpleRequest(new Request(`${BASE}/x?${METHOD_OVERRIDE_PARAM}=${given}`, { method: "POST", body: "{}" }));
    assert.equal(out.method, want);
  }
});

test("_idempotency_key is promoted to the Idempotency-Key header", () => {
  const out = unwrapSimpleRequest(new Request(`${BASE}/api/bulk/delete?${IDEMPOTENCY_KEY_PARAM}=k-123`, { method: "POST", body: "{}" }));
  assert.equal(out.method, "POST");
  assert.equal(out.headers.get("Idempotency-Key"), "k-123");
  assert.equal(new URL(out.url).searchParams.has(IDEMPOTENCY_KEY_PARAM), false);
});

test("an explicit Idempotency-Key header wins over the query param", () => {
  const out = unwrapSimpleRequest(new Request(`${BASE}/api/bulk/delete?${IDEMPOTENCY_KEY_PARAM}=from-query`, {
    method: "POST", body: "{}", headers: { "Idempotency-Key": "from-header" },
  }));
  assert.equal(out.headers.get("Idempotency-Key"), "from-header");
});

test("a GET is never upgraded, even with _method present", () => {
  const req = new Request(`${BASE}/api/leads?${METHOD_OVERRIDE_PARAM}=DELETE`, { method: "GET" });
  const out = unwrapSimpleRequest(req);
  assert.equal(out, req);
  assert.equal(out.method, "GET");
});

test("unknown _method values are left for the router to reject", () => {
  const req = new Request(`${BASE}/api/leads?${METHOD_OVERRIDE_PARAM}=TRACE`, { method: "POST", body: "{}" });
  const out = unwrapSimpleRequest(req);
  assert.equal(out, req);
  assert.equal(out.method, "POST");
});

test("a plain POST without tunnel params is returned untouched", () => {
  const req = new Request(`${BASE}/api/leads`, { method: "POST", body: "{}" });
  assert.equal(unwrapSimpleRequest(req), req);
});
