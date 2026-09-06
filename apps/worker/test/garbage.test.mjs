// Task #1: Garbage Entity Detector unit tests. Covers every heuristic
// branch in isGarbage(), the AI second-opinion threshold + honest
// degradation, and the sweep upper bound. Pure-JS — no DB/network.

import { test } from "node:test";
import assert from "node:assert/strict";

const { isGarbage, aiSecondOpinion, evaluateEntity, runCleanupSweep, classifyPersonName } =
  await import("../test-dist/entities/garbage.js");

// ---------- 1. isGarbage — positive fixtures ----------------------------
test("isGarbage: empty / whitespace name flagged", () => {
  assert.equal(isGarbage({ kind: "org", display_name: "" }).is_garbage, true);
  assert.equal(isGarbage({ kind: "org", display_name: "   " }).is_garbage, true);
  assert.deepEqual(isGarbage({ kind: "org", display_name: "" }).reasons, ["empty_name"]);
});

test("isGarbage: page-title with `|` brand fragment", () => {
  const v = isGarbage({ kind: "org", display_name: "Our Team | Sequoia Capital" });
  assert.equal(v.is_garbage, true);
  assert.ok(v.reasons.includes("page_title_pipe_fragment"));
});

test("isGarbage: press leader phrases (Introducing/Announcing/Welcome to/How/Why)", () => {
  for (const name of ["Introducing Cogna", "Announcing Series B", "Welcome to Acme", "How we built X", "Why we invested"]) {
    const v = isGarbage({ kind: "org", display_name: name });
    assert.equal(v.is_garbage, true, `expected garbage for ${name}`);
    assert.ok(v.reasons.includes("press_leader_phrase"));
  }
});

test("isGarbage: pure emoji / icon name", () => {
  const v = isGarbage({ kind: "org", display_name: "★★★" });
  assert.equal(v.is_garbage, true);
  assert.ok(v.reasons.includes("no_alphanumeric_chars"));
});

test("isGarbage: name longer than 80 chars", () => {
  const v = isGarbage({ kind: "org", display_name: "a".repeat(81) });
  assert.equal(v.is_garbage, true);
  assert.ok(v.reasons.includes("name_too_long"));
});

test("isGarbage: known UI strings (case-insensitive)", () => {
  for (const name of ["Contact Us", "Search Icon", "Limited Partners", "Privacy Policy", "Login"]) {
    const v = isGarbage({ kind: "org", display_name: name });
    assert.equal(v.is_garbage, true, `expected garbage for ${name}`);
    assert.ok(v.reasons.includes("known_ui_string"));
  }
});

test("isGarbage: person without space, or with separator chars", () => {
  const a = isGarbage({ kind: "person", display_name: "guillaume" });
  assert.equal(a.is_garbage, true);
  assert.ok(a.reasons.includes("person_no_space"));

  const b = isGarbage({ kind: "person", display_name: "Contact | Sequoia" });
  assert.equal(b.is_garbage, true);
  assert.ok(b.reasons.includes("person_contains_separator"));

  const c = isGarbage({ kind: "person", display_name: "team/people:1" });
  assert.equal(c.is_garbage, true);
  assert.ok(c.reasons.includes("person_contains_separator"));
});

// ---------- 2. isGarbage — negative fixtures (real names pass) ----------
test("isGarbage: real organization names pass", () => {
  for (const name of ["Sequoia Capital", "Andreessen Horowitz", "Stripe", "OpenAI", "Tenity GmbH"]) {
    const v = isGarbage({ kind: "org", display_name: name });
    assert.equal(v.is_garbage, false, `expected NOT garbage for ${name}: ${v.reasons.join(",")}`);
  }
});

test("isGarbage: real person names pass", () => {
  for (const name of ["Roelof Botha", "Marc Andreessen", "Guillaume Lauzier"]) {
    const v = isGarbage({ kind: "person", display_name: name });
    assert.equal(v.is_garbage, false, `expected NOT garbage for ${name}`);
  }
});

// ---------- 3. AI second-opinion honest degradation --------------------
test("aiSecondOpinion: missing AI binding returns uncertain (never garbage)", async () => {
  const env = {}; // no env.AI binding
  const v = await aiSecondOpinion(env, { kind: "org", display_name: "Some Ambiguous Name 30-60 chars long" });
  assert.equal(v.verdict, "uncertain");
  assert.equal(v.confidence, 0);
  assert.equal(v.reason, "ai_binding_missing");
});

test("aiSecondOpinion: AI run() throwing returns uncertain (graceful)", async () => {
  const env = { AI: { run: async () => { throw new Error("boom"); } } };
  const v = await aiSecondOpinion(env, { kind: "org", display_name: "Some Name" });
  assert.equal(v.verdict, "uncertain");
  assert.equal(v.confidence, 0);
  assert.ok(String(v.reason).startsWith("ai_error:"));
});

test("aiSecondOpinion: garbage verdict + high confidence parsed", async () => {
  const env = {
    AI: {
      run: async () => ({ response: '{"verdict":"garbage","confidence":0.9,"reason":"page title"}' }),
    },
  };
  const v = await aiSecondOpinion(env, { kind: "org", display_name: "Read more about us" });
  assert.equal(v.verdict, "garbage");
  assert.equal(v.confidence, 0.9);
});

test("aiSecondOpinion: malformed response returns uncertain", async () => {
  const env = { AI: { run: async () => ({ response: "not json at all" }) } };
  const v = await aiSecondOpinion(env, { kind: "org", display_name: "X" });
  assert.equal(v.verdict, "uncertain");
});

// ---------- 4. evaluateEntity AI threshold + length gate ---------------
test("evaluateEntity: heuristic match short-circuits (no AI call)", async () => {
  let aiCalled = false;
  const env = { AI: { run: async () => { aiCalled = true; return { response: '{"verdict":"real","confidence":0.9}' }; } } };
  const v = await evaluateEntity(env, { kind: "org", display_name: "Contact Us" });
  assert.equal(v.is_garbage, true);
  assert.equal(aiCalled, false, "AI must not be called when heuristic already flags");
});

test("evaluateEntity: AI only fires for names 30-60 chars with no heuristic", async () => {
  let aiCalled = false;
  const env = { AI: { run: async () => { aiCalled = true; return { response: '{"verdict":"garbage","confidence":0.9}' }; } } };
  await evaluateEntity(env, { kind: "org", display_name: "Short" });
  assert.equal(aiCalled, false, "short names skip AI");
  await evaluateEntity(env, { kind: "org", display_name: "A".repeat(70) });
  assert.equal(aiCalled, false, "name_too_long is heuristic; AI not consulted");
});

test("evaluateEntity: AI flags only when confidence > 0.8", async () => {
  const name = "An ambiguous middle-length name string"; // 38 chars
  const high = { AI: { run: async () => ({ response: '{"verdict":"garbage","confidence":0.9}' }) } };
  const low = { AI: { run: async () => ({ response: '{"verdict":"garbage","confidence":0.75}' }) } };
  const vh = await evaluateEntity(high, { kind: "org", display_name: name });
  assert.equal(vh.is_garbage, true);
  assert.ok(vh.reasons.includes("ai_second_opinion"));
  const vl = await evaluateEntity(low, { kind: "org", display_name: name });
  assert.equal(vl.is_garbage, false, "below 0.8 must not flag");
});

test("evaluateEntity: missing AI binding never flags ambiguous names", async () => {
  const name = "An ambiguous middle-length name string";
  const v = await evaluateEntity({}, { kind: "org", display_name: name });
  assert.equal(v.is_garbage, false);
});

// ---------- 5. runCleanupSweep upper bound + soft-delete-only ----------
function makeFakeEnv({ rows, mode = "recent" } = {}) {
  const calls = { update: [], delete: [], log: [] };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              async run() {
                if (/UPDATE u_entities/i.test(sql)) calls.update.push({ sql, binds });
                else if (/DELETE FROM entity_roles/i.test(sql)) calls.delete.push({ sql, binds });
                else if (/INSERT INTO data_quality_log/i.test(sql)) calls.log.push({ sql, binds });
                return { meta: {} };
              },
              async first() {
                // isStructurallyOrphan probe — return zeros so structural rule fires.
                return { facts: 0, rels: 0, chans: 0, age_hours: 48 };
              },
              async all() {
                if (/FROM u_entities[\s\S]*ORDER BY created_at/i.test(sql)) {
                  // limit binding is last
                  const limit = binds[binds.length - 1];
                  return { results: rows.slice(0, limit) };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  return { env, calls };
}

test("runCleanupSweep: soft-deletes flagged rows, never hard-deletes u_entities", async () => {
  const rows = [
    { id: "e1", kind: "org", display_name: "Contact Us", primary_url: null, primary_domain: null, primary_email_key: null, primary_linkedin_key: null },
    { id: "e2", kind: "org", display_name: "Sequoia Capital", primary_url: null, primary_domain: null, primary_email_key: null, primary_linkedin_key: null },
    { id: "e3", kind: "org", display_name: "Our Team | Acme", primary_url: null, primary_domain: null, primary_email_key: null, primary_linkedin_key: null },
  ];
  const { env, calls } = makeFakeEnv({ rows });
  const r = await runCleanupSweep(env, { mode: "recent", lookbackHours: 6, limit: 100, skipAi: true });
  assert.equal(r.scanned, 3);
  // e1, e3 flagged via heuristic; e2 ("Sequoia Capital") flagged via structural-orphan rule (probe returns zeros)
  assert.equal(r.flagged, 3);
  assert.equal(r.soft_deleted, 3);
  // Every UPDATE must set status='soft_deleted'; NEVER a DELETE FROM u_entities.
  for (const u of calls.update) {
    assert.ok(/status\s*=\s*'soft_deleted'/i.test(u.sql), "update must soft-delete only");
  }
  assert.equal(calls.delete.length, 3, "entity_roles rows must be removed per soft-delete");
});

test("runCleanupSweep: respects limit bound (5000 cap honored)", async () => {
  // Synthesize 100 garbage rows; cap at 25.
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: "e" + i, kind: "org", display_name: "Contact Us",
    primary_url: null, primary_domain: null,
    primary_email_key: null, primary_linkedin_key: null,
  }));
  const { env } = makeFakeEnv({ rows });
  const r = await runCleanupSweep(env, { mode: "recent", limit: 25, skipAi: true });
  assert.equal(r.scanned, 25, "scanned capped at limit");
  assert.equal(r.bounded, true, "bounded flag set when limit hit");
});

// ---------- 6. Pre-insert guard contract --------------------------------
// We can't easily import createEntity (its module pulls Workers types),
// but we verify the guard contract: isGarbage('Contact Us') flags and
// callers must skip insert. roles.ts:42-54 is the live guard.
test("pre-insert guard: known garbage names produce is_garbage=true (caller must skip)", () => {
  for (const name of ["Contact Us", "Our Team | Acme", "Introducing Cogna", "★", ""]) {
    assert.equal(isGarbage({ kind: "org", display_name: name }).is_garbage, true);
  }
});

// ---------- 7. Task #6: classifyPersonName ------------------------------
test("classifyPersonName: organizations scraped as people", () => {
  const fixtures = [
    ["Intel Capital", "investor_firm"],
    ["Mendoza Ventures", "investor_firm"],
    ["Backstage Capital", "investor_firm"],
    ["Hillman Accelerator Foundation", "accelerator"],
  ];
  for (const [name, role] of fixtures) {
    const c = classifyPersonName(name);
    assert.equal(c.verdict, "organization", `expected organization for ${name}`);
    assert.equal(c.orgRole, role, `expected role ${role} for ${name}`);
  }
});

test("classifyPersonName: page junk scraped as people", () => {
  for (const name of [
    "Updated Homepage Image", "Our Mission", "Map of the Money",
    "Wayback Machine", "Deep Tech", "Startup Mentorship Hub", "North America",
  ]) {
    assert.equal(classifyPersonName(name).verdict, "junk", `expected junk for ${name}`);
  }
});

test("classifyPersonName: real people pass as person", () => {
  for (const name of ["Roelof Botha", "Marc Andreessen", "Guillaume Lauzier", "Jane Doe"]) {
    assert.equal(classifyPersonName(name).verdict, "person", `expected person for ${name}`);
  }
});

test("classifyPersonName: precision guard — 2-token person whose surname collides with a junk word is NOT junk", () => {
  // "Banner"/"Map" are asset/UI words but also plausible surnames; a clean
  // two-token Title-Case name must never auto-delete a real person.
  for (const name of ["John Banner", "John Map", "Sarah Gallery"]) {
    assert.notEqual(classifyPersonName(name).verdict, "junk", `must not soft-delete ${name}`);
  }
  // ...but real ≥3-token captions and all-generic 2-token phrases stay junk.
  assert.equal(classifyPersonName("Updated Homepage Image").verdict, "junk");
  assert.equal(classifyPersonName("Wayback Machine").verdict, "junk");
});

test("isGarbage flags junk person names but NOT organization names", () => {
  assert.equal(isGarbage({ kind: "person", display_name: "Updated Homepage Image" }).is_garbage, true);
  // Organizations are reclassified, not soft-deleted — must not be garbage.
  assert.equal(isGarbage({ kind: "person", display_name: "Intel Capital" }).is_garbage, false);
  // Real people remain untouched.
  assert.equal(isGarbage({ kind: "person", display_name: "Jane Doe" }).is_garbage, false);
});

// ---------- 8. Task #6: sweep reclassifies org-named persons ------------
test("runCleanupSweep: flips org-named person to org (no firm row when domain absent)", async () => {
  const rows = [
    { id: "p1", kind: "person", display_name: "Intel Capital", primary_url: null, primary_domain: null, primary_email_key: null, primary_linkedin_key: null },
    { id: "p2", kind: "person", display_name: "Updated Homepage Image", primary_url: null, primary_domain: null, primary_email_key: null, primary_linkedin_key: null },
  ];
  const { env, calls } = makeFakeEnv({ rows });
  const r = await runCleanupSweep(env, { mode: "recent", limit: 100, skipAi: true });
  assert.equal(r.reclassified, 1, "Intel Capital reclassified to org");
  assert.ok(r.soft_deleted >= 1, "junk person soft-deleted");
  // The reclassify path flips kind to 'org' and logs a 'reclassified' row.
  assert.ok(calls.update.some((u) => /kind\s*=\s*'org'/i.test(u.sql)), "kind flipped to org");
  assert.ok(calls.log.some((l) => l.binds[1] === "reclassified"), "reclassified audit row written");
});

test("runCleanupSweep: org-named person WITH email is flagged for review, not flipped", async () => {
  const rows = [
    { id: "p3", kind: "person", display_name: "Marcus Partners", primary_url: null, primary_domain: null, primary_email_key: "marcus@x.com", primary_linkedin_key: null },
  ];
  const { env, calls } = makeFakeEnv({ rows });
  const r = await runCleanupSweep(env, { mode: "recent", limit: 100, skipAi: true });
  assert.equal(r.reclassified, 0, "not auto-flipped when a person signal is present");
  assert.equal(r.needs_review, 1, "flagged for operator review instead");
  assert.ok(calls.log.some((l) => l.binds[1] === "needs_review"), "needs_review audit row written");
});

// ---------- listicle titles and domain-slug names -----------------------
//
// The gap that let ~128 non-firms into the firms table. A crawler ingested
// aggregator pages and made one entity per outbound link, taking the page
// title as the name and the domain slug for the rest. None of the earlier
// rules could catch it: such titles have no pipe fragment, no press leader,
// are well under 80 characters and are not known nav strings.
//
// A single matched reason marks an entity garbage and the sweep soft-deletes
// it, so the false-positive control below matters more than the positives.

test("isGarbage: listicle / directory page titles flagged", () => {
  const titles = [
    "VC Firms By Stage",              // the actual polluting row
    "Investors by sector",
    "Seed Funds by geography",
    "Top 50 VC Firms",
    "The Best 10 Seed Funds",
    "List of European VCs",
    "Directory of angel investors",
    "The Ultimate Guide to Seed Funds",
    "Complete List of Climate Funds",
  ];
  for (const t of titles) {
    const v = isGarbage({ kind: "org", display_name: t });
    assert.equal(v.is_garbage, true, `"${t}" should be flagged`);
    assert.ok(v.reasons.includes("listicle_page_title"), `"${t}" reason: ${v.reasons}`);
  }
});

test("isGarbage: real firm names are NOT mistaken for listicles", () => {
  // Every one of these is a real venture firm, and several are deliberately
  // adversarial against the patterns: a leading "Top", the bare word
  // "Stage", "Index", a plural, a number.
  const real = [
    "Top Tier Capital Partners",
    "Stage Fund",
    "Stage 2 Capital",
    "Index Ventures",
    "Founders Fund",
    "First Round Capital",
    "Seven Seven Six",
    "500 Global",
    "Two Sigma Ventures",
    "8VC",
    "Sequoia Capital",
    "Andreessen Horowitz",
    "Bessemer Venture Partners",
    "Lightspeed Venture Partners",
    "New Enterprise Associates",
    "Union Square Ventures",
    "General Catalyst",
    "Insight Partners",
    "Northzone",
    "Speedinvest",
  ];
  for (const name of real) {
    const v = isGarbage({ kind: "org", display_name: name });
    assert.ok(
      !v.reasons.includes("listicle_page_title"),
      `real firm "${name}" was flagged as a listicle: ${v.reasons}`,
    );
  }
});

test("isGarbage: a name that is only its own domain slug is flagged", () => {
  const cases = [
    ["Firstmarkcap", "firstmarkcap.com"],
    ["Forerunnerventures", "forerunnerventures.com"],
    ["Collaborativefund", "collaborativefund.com"],
    ["Digitalundivided", "digitalundivided.com"],
    ["Foundersfirstcapitalpartners", "foundersfirstcapitalpartners.com"],
  ];
  for (const [name, domain] of cases) {
    const v = isGarbage({ kind: "org", display_name: name, primary_domain: domain });
    assert.ok(v.reasons.includes("domain_slug_name"),
      `"${name}" @ ${domain} should read as URL-derived: ${v.reasons}`);
  }
});

test("isGarbage: short single-word brands that equal their domain are safe", () => {
  // The length gate exists for exactly these — a real brand whose name IS
  // its domain must survive.
  for (const [name, domain] of [
    ["Stripe", "stripe.com"],
    ["Coatue", "coatue.com"],
    ["Atomico", "atomico.com"],
    ["Floodgate", "floodgate.com"],
    ["Greylock", "greylock.com"],
    ["Balderton", "balderton.com"],
    ["Speedinvest", "speedinvest.com"],
  ]) {
    const v = isGarbage({ kind: "org", display_name: name, primary_domain: domain });
    assert.ok(!v.reasons.includes("domain_slug_name"),
      `brand "${name}" was mistaken for a slug: ${v.reasons}`);
  }
});

test("isGarbage: a properly extracted name is safe even on a matching domain", () => {
  // "FirstMark Capital" at firstmarkcap.com carries separators the slug
  // cannot, which is the whole tell.
  const v = isGarbage({
    kind: "org",
    display_name: "FirstMark Capital",
    primary_domain: "firstmarkcap.com",
  });
  assert.ok(!v.reasons.includes("domain_slug_name"), `reasons: ${v.reasons}`);
});
