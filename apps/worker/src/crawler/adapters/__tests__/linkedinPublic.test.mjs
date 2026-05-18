// Per-adapter test for linkedinPublic (Task #2 acceptance).
// NOTE: spec calls for `bun test` against `.test.ts` files. This repo
// runs node:test against a pre-compiled `test-dist/` (see package.json).
// File extension stays .mjs so the existing tsc/test pipeline picks it
// up without re-tooling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const { runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("linkedinPublic: extracts a Person from JSON-LD with structured fields", () => {
  const r = runAdapter("https://www.linkedin.com/in/jane-doe", fixture("linkedin-in.html"));
  assert.equal(r.used_adapter_id, "linkedin_public");
  assert.equal(r.fallback_reason, null);
  const cand = r.result.candidates.find((c) => c.profile_type === "firm_person");
  assert.ok(cand, "expected a firm_person candidate");
  assert.equal(cand.name, "Jane Doe");
  assert.equal(cand.data.role, "Partner");
  assert.equal(cand.data.firm_employer, "Acme Capital");
  assert.equal(cand.data.location_city, "San Francisco");
  assert.equal(cand.data.location_region, "CA");
  assert.deepEqual(cand.data.education, ["Stanford University", "MIT Sloan"]);
  assert.deepEqual(cand.data.skills, ["Venture Capital", "Fintech", "Payments"]);
  assert.equal(cand.data.profile_photo, "https://media.licdn.com/dms/image/jane.jpg");
});

test("linkedinPublic: pulls past_roles from __NEXT_DATA__ positions[]", () => {
  const r = runAdapter("https://www.linkedin.com/in/jane-doe", fixture("linkedin-in.html"));
  const cand = r.result.candidates.find((c) => c.profile_type === "firm_person");
  const past = cand.data.past_roles;
  assert.ok(Array.isArray(past) && past.length >= 1, "expected past_roles array");
  const beta = past.find((p) => p.employer === "Beta Ventures");
  assert.ok(beta, "expected Beta Ventures in past_roles");
  assert.equal(beta.role, "Principal");
  assert.equal(beta.start_year, 2017);
  assert.equal(beta.end_year, 2020);
});

test("linkedinPublic: OG-only snapshot still yields a candidate (fallback path)", () => {
  const html = `<!doctype html><html><head>
<meta property="og:title" content="John Roe - Partner at Beta - LinkedIn">
<meta property="og:image" content="https://media.licdn.com/x.jpg">
</head><body/></html>`;
  const r = runAdapter("https://www.linkedin.com/in/john-roe", html);
  const cand = r.result.candidates[0];
  assert.equal(cand.name, "John Roe");
  assert.equal(cand.data.firm_employer, "Beta");
});
