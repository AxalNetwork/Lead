// Dashboard side of the CORS-simple tunnel (apps/site/assets/js/ads-utils.js).
// Cloudflare Access rejects every CORS preflight, so the helper must turn any
// dashboard API call into a "simple request", and no dashboard script may
// bypass it with a bare fetch(). Both are source/sandbox tests: no DOM needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, "../../site");
const src = readFileSync(join(SITE, "assets/js/ads-utils.js"), "utf8");

function load() {
  const calls = [];
  const sandbox = {
    window: {},
    console: { warn() {} },
    Headers,
    fetch: (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}), text: async () => "" }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { util: sandbox.window.adsUtil, calls };
}

test("JSON content-type is dropped and the body is kept", () => {
  const { util } = load();
  const [url, init] = util.toSimpleRequest("https://api.example/api/leads", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}',
  });
  assert.equal(url, "https://api.example/api/leads");
  assert.equal(init.method, "POST");
  assert.equal(init.body, '{"a":1}');
  assert.deepEqual(Object.keys(init.headers), []);
  assert.equal(init.credentials, "include");
});

test("PUT/PATCH/DELETE tunnel as POST + ?_method=, preserving existing query and hash", () => {
  const { util } = load();
  for (const m of ["PUT", "patch", "DELETE"]) {
    const [url, init] = util.toSimpleRequest("https://api.example/api/x?a=1#frag", { method: m, body: "{}" });
    assert.equal(init.method, "POST");
    assert.equal(url, `https://api.example/api/x?a=1&_method=${m.toUpperCase()}#frag`);
  }
});

test("Idempotency-Key moves to ?_idempotency_key=; safelisted headers survive; Headers instances work", () => {
  const { util } = load();
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "Idempotency-Key": "k 1", Accept: "application/json" });
  const [url, init] = util.toSimpleRequest("https://api.example/api/bulk/export", { method: "POST", headers: h, body: "{}" });
  assert.equal(url, "https://api.example/api/bulk/export?_idempotency_key=k%201");
  assert.deepEqual(Object.keys(init.headers).map((k) => k.toLowerCase()), ["accept"]);
});

test("simple content types (multipart/urlencoded/text) are left alone; GET stays GET", () => {
  const { util } = load();
  const [, init] = util.toSimpleRequest("https://api.example/api/uploads", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" } });
  assert.equal(init.headers["Content-Type"], "multipart/form-data; boundary=x");
  const [url, g] = util.toSimpleRequest("https://api.example/api/leads", {});
  assert.equal(g.method, "GET");
  assert.equal(url, "https://api.example/api/leads");
});

test("request() and apiFetch() go through the normaliser", async () => {
  const { util, calls } = load();
  await util.request("https://api.example/api/personas/p1", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  await util.apiFetch("https://api.example/api/personas", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.example/api/personas/p1?_method=DELETE");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(Object.keys(calls[1].opts.headers), []);
});

// ---- Regression guard: no dashboard script may call bare fetch() ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (["vendor", "images", "type", "_site"].includes(name)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}
const EXEMPT = new Set(["ads-utils.js", "plugins.js", "scripts.js"]);

test("dashboard code never calls bare fetch() — use window.adsUtil.request / apiFetch", () => {
  const offenders = [];
  for (const dir of ["assets/js", "dashboard", "_includes", "_layouts"]) {
    for (const f of walk(join(SITE, dir))) {
      const base = f.split("/").pop();
      if (EXEMPT.has(base) || /\.min\.js$/.test(base)) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/(^|[^A-Za-z0-9_.$])fetch\(/.test(line) && !/^\s*(\/\/|\*|<!--)/.test(line)) offenders.push(`${f.slice(SITE.length + 1)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `bare fetch() found (Access rejects preflights; route through adsUtil.request):\n${offenders.join("\n")}`);
});
