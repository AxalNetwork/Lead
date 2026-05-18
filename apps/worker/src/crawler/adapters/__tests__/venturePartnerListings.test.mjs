import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const { runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("venturePartnerListings: /team/ directory emits >=5 gp_partner candidates", () => {
  const url = "https://www.firstround.com/team/";
  const r = runAdapter(url, fixture("firstround-team.html"));
  assert.equal(r.used_adapter_id, "venture_partner_listings");
  assert.equal(r.fallback_reason, null);
  const partners = r.result.candidates.filter((c) => c.profile_type === "gp_partner");
  assert.ok(partners.length >= 5, `expected >=5 gp_partners, got ${partners.length}`);
  for (const p of partners) {
    assert.ok(p.url && /firstround\.com\/team\/[a-z]/.test(p.url), `unexpected url ${p.url}`);
    assert.equal(p.data.firm_employer, "firstround");
  }
  const names = partners.map((p) => p.name);
  assert.ok(!names.includes("About") && !names.includes("Portfolio") && !names.includes("Careers"));
  assert.equal(r.result.child_urls.length, partners.length);
});
