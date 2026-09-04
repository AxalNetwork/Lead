// /api/* pagination guard: negative / non-numeric limit+offset must be a 400,
// never a full-table dump (SQLite: negative LIMIT = unbounded) or a D1 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const { findPaginationProblem } = await import("../test-dist/middleware/pagination.js");
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

const check = (qs) => findPaginationProblem(new URLSearchParams(qs));

test("valid pagination passes through", () => {
  for (const qs of ["", "limit=50", "limit=1&offset=0", "offset=250", "page=3&page_size=20", "per_page=100", "q=x&sort_by=name"]) {
    assert.equal(check(qs), null, qs);
  }
});

test("negative, zero, and non-numeric page sizes are rejected", () => {
  for (const qs of ["limit=-1", "limit=-2", "limit=0", "limit=abc", "limit=", "limit=1.5", "limit=1e3", "page_size=0", "per_page=-5"]) {
    const p = check(qs);
    assert.ok(p, `expected a problem for ${qs}`);
  }
  assert.equal(check("limit=-1").param, "limit");
});

test("negative and non-numeric offsets are rejected; zero offset is fine", () => {
  assert.equal(check("offset=0"), null);
  assert.equal(check("offset=-1")?.param, "offset");
  assert.equal(check("offset=abc")?.param, "offset");
  assert.equal(check("page=x")?.param, "page");
});

test("absurdly long numerics are rejected before they reach Number()", () => {
  assert.ok(check("limit=99999999999999999999"));
});

test("guard is mounted on /api/* in src/index.ts after accessGuard", () => {
  const guard = indexSrc.indexOf('api.use("/api/*", accessGuard)');
  const pag = indexSrc.indexOf('api.use("/api/*", boundedPagination)');
  assert.ok(guard > 0 && pag > guard, "boundedPagination must be mounted on /api/* after accessGuard");
});
