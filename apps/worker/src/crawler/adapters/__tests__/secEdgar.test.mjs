import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const { runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("secEdgar: parses filing rows and emits child filing URLs", () => {
  const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000012345&type=10-K";
  const r = runAdapter(url, fixture("sec-edgar.html"));
  assert.equal(r.used_adapter_id, "sec_edgar");
  assert.equal(r.fallback_reason, null);
  const data = r.result.candidates[0].data;
  assert.equal(data.cik, "0000012345");
  assert.equal(data.registrant_name, "EXAMPLE TECHNOLOGIES INC.");
  assert.ok(data.filings.length >= 3, `expected >=3 filings, got ${data.filings.length}`);
  assert.ok(data.filings.some((f) => f.form === "10-K"));
  assert.ok(r.result.child_urls.length > 0, "expected child filing URLs");
});
