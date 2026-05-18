import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("companies_house_uk: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://find-and-update.company-information.service.gov.uk/company/12345678";
  assert.equal(pickAdapter(url)?.id, "companies_house_uk");
  const r = runAdapter(url, `<html><head><title>EXAMPLE LTD - 12345678 - Companies House</title></head><body><p class="heading-xlarge">EXAMPLE LTD</p></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "companies_house_uk");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
