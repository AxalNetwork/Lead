// Task #7 identity-harvest unit tests. Pure-TS / no D1 — exercises the
// deterministic contact harvester (email cleaning, role-inbox rejection,
// social-URL extraction) and the parseProfileUrl handle parser that the
// promote pass depends on.

import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = "../test-dist";

test("cleanEmail: accepts a plain personal address, lowercases, strips query", async () => {
  const { cleanEmail } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  assert.equal(cleanEmail("Jane.Doe@Example-corp.com"), "jane.doe@example-corp.com");
  assert.equal(cleanEmail("jane@acme.io?subject=hi"), "jane@acme.io");
});

test("cleanEmail: rejects role inboxes, placeholders, file-refs, malformed", async () => {
  const { cleanEmail } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  assert.equal(cleanEmail("info@acme.com"), null);
  assert.equal(cleanEmail("careers@acme.com"), null);
  assert.equal(cleanEmail("noreply@acme.com"), null);
  assert.equal(cleanEmail("someone@example.com"), null);
  assert.equal(cleanEmail("logo@2x.png"), null);
  assert.equal(cleanEmail("notanemail"), null);
  assert.equal(cleanEmail("a..b@acme.com"), null);
  assert.equal(cleanEmail(""), null);
});

test("isRoleInbox: classifies generic mailboxes", async () => {
  const { isRoleInbox } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  assert.equal(isRoleInbox("support@x.com"), true);
  assert.equal(isRoleInbox("hr@x.com"), true);
  assert.equal(isRoleInbox("jane.doe@x.com"), false);
});

test("harvestIdentityFacts: empty html → no facts (honest about nothing)", async () => {
  const { harvestIdentityFacts } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  assert.deepEqual(harvestIdentityFacts("", { url: "https://x.com", tag: "self" }), []);
});

test("harvestIdentityFacts: extracts mailto, social URLs; skips reserved + role", async () => {
  const { harvestIdentityFacts } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  const html = `
    <a href="mailto:jane.doe@acme.io">email</a>
    <a href="mailto:info@acme.io">contact us</a>
    <a href="https://www.linkedin.com/in/jane-doe-123">li</a>
    <a href="https://twitter.com/janedoe">tw</a>
    <a href="https://twitter.com/home">nope</a>
    <a href="https://github.com/janedoe">gh</a>
    <a href="https://github.com/features">product</a>
    <a href="https://github.com/janedoe/somerepo">repo</a>
  `;
  const facts = harvestIdentityFacts(html, { url: "https://acme.io/team/jane", tag: "self" });
  const byPred = (p) => facts.filter((f) => f.predicate === p).map((f) => f.valueText);

  assert.deepEqual(byPred("email"), ["jane.doe@acme.io"]);
  assert.deepEqual(byPred("linkedin_url"), ["https://www.linkedin.com/in/jane-doe-123"]);
  assert.deepEqual(byPred("twitter_url"), ["https://twitter.com/janedoe"]);
  assert.deepEqual(byPred("github_url"), ["https://github.com/janedoe"]);
  for (const f of facts) {
    assert.equal(f.sourceUrl, "https://acme.io/team/jane");
    assert.equal(f.sourceTag, "self");
    assert.ok(f.confidence > 0 && f.confidence < 1);
  }
});

test("harvestIdentityFacts: selfUrl on a non-platform host yields website; platform host does not", async () => {
  const { harvestIdentityFacts } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  const src = { url: "https://janedoe.me/about", tag: "self" };
  const own = harvestIdentityFacts("<p>hi</p>", src, { selfUrl: "https://janedoe.me/about" });
  assert.deepEqual(own.filter((f) => f.predicate === "website").map((f) => f.valueText), ["https://janedoe.me"]);

  const onPlatform = harvestIdentityFacts("<p>hi</p>", src, { selfUrl: "https://linkedin.com/in/jane" });
  assert.equal(onPlatform.filter((f) => f.predicate === "website").length, 0);
});

test("harvestIdentityFacts: de-dupes repeated values", async () => {
  const { harvestIdentityFacts } = await import(`${ROOT}/crawler/profileWorkflows/identityHarvest.js`);
  const html = `mail jane@acme.io and again jane@acme.io
    <a href="https://github.com/janedoe">a</a> <a href="https://github.com/janedoe">b</a>`;
  const facts = harvestIdentityFacts(html, { url: "https://acme.io", tag: "self" });
  assert.equal(facts.filter((f) => f.predicate === "email").length, 1);
  assert.equal(facts.filter((f) => f.predicate === "github_url").length, 1);
});

test("parseProfileUrl: social URLs map to platform + handle for the promote pass", async () => {
  const { parseProfileUrl } = await import(`${ROOT}/osint/platforms.js`);
  const gh = parseProfileUrl("https://github.com/janedoe");
  assert.ok(gh && gh.platform === "github" && gh.handle === "janedoe");
  const tw = parseProfileUrl("https://twitter.com/janedoe");
  assert.ok(tw && tw.platform === "twitter" && tw.handle === "janedoe");
});
