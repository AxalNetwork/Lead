// Task #68: GET /api/dd/scores/by-ref overflowed D1's bound-parameter cap
// ("too many SQL variables") whenever the caller passed ~100+ ids, because the
// handler bound `table` + every id into ONE `IN (...)` clause. The fix chunks
// the ids into batches of 50 and merges the rows. The Hono entrypoint imports
// CF bindings at module load (same constraint noted in people.test.mjs), so we
// assert the handler's SQL/contract shape from source rather than invoking it,
// and separately prove the chunking math holds for the reported id counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ddSrc = readFileSync(resolve(__dirname, "../src/routes/dd.ts"), "utf8");

// Isolate the by-ref handler body so assertions can't accidentally match other
// routes in the file.
const byRefStart = ddSrc.indexOf('ddRoute.get("/scores/by-ref"');
assert.ok(byRefStart > -1, "by-ref handler not found");
const byRefEnd = ddSrc.indexOf("ddRoute.get(\"/scores/:entityId\"", byRefStart);
const handler = ddSrc.slice(byRefStart, byRefEnd > -1 ? byRefEnd : undefined);

test("by-ref keeps the ALLOWED table guard and empty-input short-circuits", () => {
  assert.match(handler, /const ALLOWED = new Set\(\[/);
  assert.match(handler, /if \(!ALLOWED\.has\(table\)\) return c\.json\(\{ error: "bad_table"/);
  assert.match(handler, /if \(!idsRaw\) return c\.json\(\{ items: \{\} \}\)/);
  assert.match(handler, /if \(!ids\.length\) return c\.json\(\{ items: \{\} \}\)/);
});

test("by-ref chunks the id batch (loop, slice, IN over the slice — not all ids)", () => {
  // A batched loop with headroom under D1's bound-parameter cap.
  assert.match(handler, /for \(let i = 0; i < ids\.length; i \+= 50\)/);
  assert.match(handler, /const slice = ids\.slice\(i, i \+ 50\)/);
  // Placeholders are built from the slice, and only the slice (plus the single
  // leading `table` bind) is bound per statement.
  assert.match(handler, /const placeholders = slice\.map\(\(\) => "\?"\)\.join\(","\)/);
  assert.match(handler, /\.bind\(table, \.\.\.slice\)/);
  // The old single-shot bind over every id must be gone.
  assert.doesNotMatch(handler, /\.bind\(table, \.\.\.ids\)/);
});

test("by-ref preserves the response shape (ref_id-keyed items map)", () => {
  assert.match(handler, /WHERE e\.ref_table = \? AND e\.ref_id IN \(\$\{placeholders\}\)/);
  assert.match(handler, /items\[String\(row\.ref_id\)\] = \{/);
  assert.match(handler, /return c\.json\(\{ items \}\)/);
});

test("chunking math stays under the bind cap for the reported id counts", () => {
  // Mirror the handler's batching to prove every statement binds well under
  // D1's ~100-variable ceiling (1 table bind + <=50 ids = 51 binds max).
  const CHUNK = 50;
  for (const n of [1, 50, 99, 100, 116, 500]) {
    const ids = Array.from({ length: n }, (_, i) => "id" + i);
    let covered = 0;
    let maxBinds = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      covered += slice.length;
      maxBinds = Math.max(maxBinds, 1 + slice.length); // leading `table` + ids
    }
    assert.equal(covered, n, `all ${n} ids covered`);
    assert.ok(maxBinds <= 51, `max binds ${maxBinds} <= 51 for n=${n}`);
    assert.ok(maxBinds < 100, `max binds ${maxBinds} under D1 cap for n=${n}`);
  }
});

test("by-ref still caps the total id list at 500", () => {
  assert.match(handler, /\.slice\(0, 500\)/);
});
