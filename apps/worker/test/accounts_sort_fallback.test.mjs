// Task #67: click-to-sort on the Accounts list is server-side. The ORDER BY
// is built from an allowlist (public sort key -> SQL column) so it is
// injection-safe, but an EXPLICIT sort_dir must only apply to a RECOGNIZED
// column. A request like `?sort=bogus&sort_dir=asc` must fall back to the
// baseline ordering (account_score DESC) and NOT honor the stray direction.
// These tests drive the real listAccounts against a fake D1 that captures
// the main SELECT's ORDER BY clause.

import { test } from "node:test";
import assert from "node:assert/strict";

const { listAccounts } = await import("../test-dist/prospects/repo.js");

function makeEnv() {
  const sqls = [];
  function stmt(sql) {
    return {
      sql, _binds: [],
      bind(...a) { this._binds = a; return this; },
      async all() { sqls.push(sql); return { results: [] }; },
      async first() { sqls.push(sql); return { n: 0, avg_a: 0, avg_i: 0, avg_f: 0 }; },
      async run() { return { meta: {} }; },
    };
  }
  return {
    env: { DB: { prepare(sql) { return stmt(sql); } } },
    mainOrderBy() {
      // The list SELECT is the only one that selects the full column list and
      // carries `LIMIT ? OFFSET ?`; the aggregate queries do not.
      const sql = sqls.find((s) => /FROM accounts a/.test(s) && /LIMIT \? OFFSET \?/.test(s));
      assert.ok(sql, "main list SELECT not issued");
      const m = sql.match(/ORDER BY ([\s\S]+?)\s+LIMIT/);
      assert.ok(m, "no ORDER BY found in list SELECT");
      return m[1].replace(/\s+/g, " ").trim();
    },
  };
}

test("unknown sort key falls back to account_score DESC and ignores sort_dir", async () => {
  const a = makeEnv();
  await listAccounts(a.env, { sort: "not_real", sort_dir: "asc", limit: 50, offset: 0 });
  assert.equal(a.mainOrderBy(), "a.account_score DESC NULLS LAST, a.id ASC");
});

test("absent sort key falls back to account_score DESC even with sort_dir=asc", async () => {
  const a = makeEnv();
  await listAccounts(a.env, { sort_dir: "asc", limit: 50, offset: 0 });
  assert.equal(a.mainOrderBy(), "a.account_score DESC NULLS LAST, a.id ASC");
});

test("valid sort key with explicit sort_dir is honored", async () => {
  const a = makeEnv();
  await listAccounts(a.env, { sort: "name", sort_dir: "asc", limit: 50, offset: 0 });
  assert.equal(a.mainOrderBy(), "lower(a.name) ASC NULLS LAST, a.id ASC");
});

test("valid sort key without sort_dir uses the column's natural default", async () => {
  const a = makeEnv();
  await listAccounts(a.env, { sort: "name", limit: 50, offset: 0 });
  assert.equal(a.mainOrderBy(), "lower(a.name) ASC NULLS LAST, a.id ASC");

  const b = makeEnv();
  await listAccounts(b.env, { sort: "intent_score", limit: 50, offset: 0 });
  assert.equal(b.mainOrderBy(), "a.intent_score DESC NULLS LAST, a.id ASC");
});
