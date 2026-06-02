// Task #13: tests for the firm HQ-country backfill.
//
// Exercises the pure resolvers (countryNameFromNotes / tldToIso2 /
// resolveFirmIso2) and the DB-backed runFirmGeoBackfill against an
// in-memory SQLite (node:sqlite, Node 22+) with the minimal `firms`
// schema the routine touches — including idempotency on re-run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ROOT = "../test-dist";
const { countryNameFromNotes, tldToIso2, resolveFirmIso2, runFirmGeoBackfill } =
  await import(`${ROOT}/scraper/geo_backfill.js`);

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE firms (
      id INTEGER PRIMARY KEY,
      name TEXT,
      website TEXT,
      domain TEXT,
      hq_country_iso2 TEXT,
      hq_region TEXT,
      notes TEXT,
      last_modified TEXT
    );
  `);
  const prepare = (sql) => {
    let pending = [];
    const obj = {
      bind: (...args) => { pending = args; return obj; },
      run: async () => { db.prepare(sql).run(...pending); return { success: true }; },
      first: async () => db.prepare(sql).get(...pending) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...pending) }),
    };
    return obj;
  };
  return { DB: { prepare }, _db: db };
}

// --- pure resolvers -------------------------------------------------------
test("countryNameFromNotes extracts the stashed hq_country_name", () => {
  assert.equal(countryNameFromNotes("hq_country_name=Japan"), "Japan");
  assert.equal(countryNameFromNotes("foo=bar;hq_country_name=United States;x=1"), "United States");
  assert.equal(countryNameFromNotes("no country here"), null);
  assert.equal(countryNameFromNotes(null), null);
});

test("tldToIso2 maps ccTLDs but ignores generic TLDs", () => {
  assert.equal(tldToIso2("https://acme.jp"), "JP");
  assert.equal(tldToIso2("www.example.co.uk"), "GB");
  assert.equal(tldToIso2("foo.de/path"), "DE");
  assert.equal(tldToIso2("acme.com"), null);
  assert.equal(tldToIso2("startup.io"), null);
  assert.equal(tldToIso2("fund.vc"), null);
  assert.equal(tldToIso2(null), null);
  assert.equal(tldToIso2("localhost"), null);
});

test("resolveFirmIso2 honors notes > region > tld priority", () => {
  // notes wins over everything
  assert.deepEqual(
    resolveFirmIso2({ notes: "hq_country_name=France", hq_region: "Germany", website: "https://x.jp" }),
    { iso2: "FR", source: "notes" },
  );
  // region used when notes absent/unrecognized
  assert.deepEqual(
    resolveFirmIso2({ notes: "hq_country_name=Narnia", hq_region: "Canada", website: "https://x.jp" }),
    { iso2: "CA", source: "region" },
  );
  // tld used when notes + region both fail
  assert.deepEqual(
    resolveFirmIso2({ notes: null, hq_region: "California", website: "https://acme.jp" }),
    { iso2: "JP", source: "tld" },
  );
  // nothing resolvable
  assert.equal(resolveFirmIso2({ notes: null, hq_region: null, website: "acme.com" }), null);
});

// --- DB-backed sweep ------------------------------------------------------
test("runFirmGeoBackfill resolves NULL rows and is idempotent", async () => {
  const env = makeEnv();
  const ins = (id, row) => env._db.prepare(
    "INSERT INTO firms (id, name, website, domain, hq_country_iso2, hq_region, notes) VALUES (?,?,?,?,?,?,?)",
  ).run(id, "f" + id, row.website ?? null, row.domain ?? null, row.iso2 ?? null, row.region ?? null, row.notes ?? null);

  ins(1, { notes: "hq_country_name=Japan" });          // notes
  ins(2, { region: "Canada" });                         // region
  ins(3, { website: "https://acme.de" });               // tld
  ins(4, { website: "acme.com" });                      // unresolvable
  ins(5, { iso2: "US", notes: "hq_country_name=Japan" }); // already set — must NOT change

  const r1 = await runFirmGeoBackfill(env);
  assert.equal(r1.scanned, 4); // row 5 excluded (iso2 already set)
  assert.equal(r1.resolved, 3);
  assert.equal(r1.unknown, 1);
  assert.deepEqual(r1.bySource, { notes: 1, region: 1, tld: 1 });

  const get = (id) => env._db.prepare("SELECT hq_country_iso2 AS c FROM firms WHERE id=?").get(id).c;
  assert.equal(get(1), "JP");
  assert.equal(get(2), "CA");
  assert.equal(get(3), "DE");
  assert.equal(get(4), null);
  assert.equal(get(5), "US"); // untouched

  // Re-run: only the still-NULL row (4) is scanned, nothing newly resolved.
  const r2 = await runFirmGeoBackfill(env);
  assert.equal(r2.scanned, 1);
  assert.equal(r2.resolved, 0);
  assert.equal(r2.unknown, 1);
});
