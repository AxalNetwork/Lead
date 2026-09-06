// Task #6: unit tests for the queue-level preflight gate + ToS sink.
//
// Covers each skip branch (proxy / circuit_open / tos / gated_manual)
// and the cleanup script. The DB is a tiny mock that records bound
// statements; we don't need a real D1 here because the preflight
// itself does at most one PK lookup per gate (via isCircuitOpen)
// and the rest is pure logic.

import { test } from "node:test";
import assert from "node:assert/strict";

const { preflight } = await import("../test-dist/scraper/preflight.js");
const { markUrlTosBlocked, cleanupTosBlockedFrontier } = await import(
  "../test-dist/services/frontier/tosSink.js"
);

function mockDb(rows = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        bind(...args) {
          calls.push({ sql, args });
          return {
            first: async () => rows[sql] ?? null,
            run: async () => ({ meta: { changes: rows[sql]?.changes ?? 0 } }),
            all: async () => ({ results: rows[sql] ?? [] }),
          };
        },
      };
      return stmt;
    },
  };
}

function env(overrides = {}, dbRows = {}) {
  return {
    DB: mockDb(dbRows),
    PROXY_URL: undefined,
    ...overrides,
  };
}

const job = (target, kind = "url", config) => ({
  jobId: "j1", kind, target, ...(config !== undefined ? { config } : {}),
});

// ---- 1. Proxy is NOT a gate -------------------------------------------
// Preflight used to skip every url-kind job when no commercial proxy
// secret was set. That discarded tier 0 (plain fetch), tier 1 (Browser
// Rendering) and tier 4 (Wayback) because tier 2 was unavailable, and it
// did so before the job reached fetch_log, so the loss was invisible.
// tier2Proxy already returns a blockResult instead of throwing when no
// provider is configured (see fetcher_proxy.test.mjs), so the escalation
// chain copes on its own.
test("preflight: no proxy configured on url-kind job → run (tier 0 needs none)", async () => {
  const r = await preflight(env(), job("https://example.com/page"));
  assert.equal(r.action, "run");
});

test("preflight: PROXY_URL set + clean host → run", async () => {
  const r = await preflight(env({ PROXY_URL: "https://proxy.example/" }), job("https://example.com/page"));
  assert.equal(r.action, "run");
});

// Task #16: any configured provider (not just legacy PROXY_URL) makes the
// job runnable.
test("preflight: only SMARTPROXY_URL set + clean host → run", async () => {
  const r = await preflight(
    env({ SMARTPROXY_URL: "https://smart.example/" }),
    job("https://example.com/page"),
  );
  assert.equal(r.action, "run");
});

test("preflight: no proxy provider at all still runs — escalation degrades, the job does not", async () => {
  const r = await preflight(env(), job("https://example.com/page"));
  assert.equal(r.action, "run");
});

// ---- 2. ToS gate -------------------------------------------------------
test("preflight: ToS-blocked host → skip:tos_blocked (regardless of proxy)", async () => {
  // Proxy unset AND tos blocked — tos wins (cheaper, more specific).
  const r1 = await preflight(env(), job("https://www.tiktok.com/@x"));
  assert.equal(r1.action, "skip");
  assert.equal(r1.skip_code, "tos_blocked");
  assert.match(r1.reason, /tiktok\.com/);

  // Even with proxy configured, tos still wins.
  const r2 = await preflight(
    env({ PROXY_URL: "https://proxy.example/" }),
    job("https://m.tiktok.com/discover")
  );
  assert.equal(r2.skip_code, "tos_blocked");
});

// ---- 3. Circuit-breaker gate ------------------------------------------
test("preflight: circuit open for host → skip:circuit_open", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const dbRows = {
    [`SELECT host, fail_count, window_start, tripped_until FROM host_circuit_breaker WHERE host = ?`]: {
      host: "www.youtube.com", fail_count: 7, window_start: new Date().toISOString(),
      tripped_until: future,
    },
  };
  const r = await preflight(
    env({ PROXY_URL: "https://proxy.example/", DB: mockDb(dbRows) }),
    job("https://www.youtube.com/watch?v=abc")
  );
  assert.equal(r.action, "skip");
  assert.equal(r.skip_code, "circuit_open");
  assert.match(r.reason, /circuit_open/);
});

test("preflight: circuit closed → run", async () => {
  const r = await preflight(
    env({ PROXY_URL: "https://proxy.example/" }),
    job("https://www.youtube.com/watch?v=abc")
  );
  assert.equal(r.action, "run");
});

// ---- 4. Gated source (NFX) --------------------------------------------
test("preflight: NFX gated source → skip:gated_source_use_manual_paste", async () => {
  const r = await preflight(
    env({ PROXY_URL: "https://proxy.example/" }),
    job("https://signal.nfx.com/investor-lists/top-seed-vcs")
  );
  assert.equal(r.action, "skip");
  assert.equal(r.skip_code, "gated_source_use_manual_paste");
});

// ---- 5. Non-URL job kinds bypass preflight ----------------------------
test("preflight: csv_import passes through with action=run (no URL target)", async () => {
  const r = await preflight(env(), job("import_123", "csv_import"));
  assert.equal(r.action, "run");
});
test("preflight: profile_list w/ enrich_kind=investor bypasses proxy gate", async () => {
  const r = await preflight(env(), job("lead_abc", "profile_list", { enrich_kind: "investor", lead_id: "lead_abc" }));
  assert.equal(r.action, "run");
});
test("preflight: parse_file bypasses proxy gate (no URL target)", async () => {
  const r = await preflight(env(), job("file_xyz", "parse_file"));
  assert.equal(r.action, "run");
});
test("preflight: import_file bypasses proxy gate (no URL target)", async () => {
  const r = await preflight(env(), job("imp_xyz", "import_file"));
  assert.equal(r.action, "run");
});

// ---- 6. Regression: skipped jobs do NOT write error_log ----------------
// The pipeline.ts wiring calls markSkipped (single jobs UPDATE) and a
// console.log; it MUST NOT call logError. This is enforced by source
// inspection — any future change that reintroduces a logError call on
// the preflight path will fail this test.
test("source: pipeline preflight handler never calls logError", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dirname, "../src/scraper/pipeline.ts"), "utf8");
  // Find the preflight block bounded by the Task #6 comment and the
  // Task #22 comment that immediately follows it.
  const a = src.indexOf("Task #6: queue-level preflight");
  const b = src.indexOf("Task #22: file-import lifecycle", a);
  assert.ok(a > 0 && b > a, "preflight block markers missing in pipeline.ts");
  const block = src.slice(a, b);
  assert.ok(!/logError\s*\(/.test(block),
    "preflight path must not write to error_log (skipped jobs are NOT errors)");
  assert.ok(/markSkipped\(/.test(block),
    "preflight path must call markSkipped");
});

// ---- 7. tosSink cleanup -----------------------------------------------
test("cleanupTosBlockedFrontier: iterates each blocked host and aggregates totals", async () => {
  const db = mockDb({});
  // Override .run to count by SQL fragment so we know each phase fired.
  const original = db.prepare.bind(db);
  let updates = 0, deletes = 0, smartUpdates = 0;
  db.prepare = (sql) => {
    const inner = original(sql);
    return {
      bind(...args) {
        const r = inner.bind(...args);
        return {
          first: r.first,
          all: r.all,
          run: async () => {
            if (sql.startsWith("UPDATE discovered_urls")) { updates++; return { meta: { changes: 1 } }; }
            if (sql.startsWith("DELETE FROM crawl_frontier")) { deletes++; return { meta: { changes: 2 } }; }
            if (sql.startsWith("UPDATE smart_frontier")) { smartUpdates++; return { meta: { changes: 3 } }; }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  };
  const r = await cleanupTosBlockedFrontier({ DB: db });
  // 7 hosts in data/tos-flags.json → 7 of each (assumes the file isn't
  // edited to fewer entries; this is the canonical denylist).
  assert.ok(updates >= 1, "should hit discovered_urls update at least once");
  assert.ok(deletes >= 1, "should hit crawl_frontier delete at least once");
  assert.ok(smartUpdates >= 1, "should hit smart_frontier update at least once");
  assert.equal(r.marked_discovered, updates * 1);
  assert.equal(r.cleared_crawl_frontier, deletes * 2);
  assert.equal(r.cleared_smart_frontier, smartUpdates * 3);
});

test("markUrlTosBlocked: no-op on invalid URL", async () => {
  const db = mockDb({});
  await markUrlTosBlocked({ DB: db }, "not a url", "reason");
  assert.equal(db.calls.length, 0);
});
