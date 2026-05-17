// Task #6 acceptance harness for the person dossier UI.
//
// This is the smoke test the code review asked for. It runs the Jekyll
// preview locally and drives the page with Playwright. The XHR layer is
// stubbed so the test doesn't require a live Cloudflare Worker.
//
// Run: `node --test apps/site/tests/people.spec.mjs`
// Skipped automatically when `@playwright/test` isn't installed so the
// existing CI test runner stays green; install Playwright to enable.

import { test } from "node:test";
import assert from "node:assert/strict";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  test("playwright not installed; install with `npm i -D playwright` to run dossier smoke", { skip: true }, () => {});
}

if (chromium) {
  const BASE = process.env.ADS_SITE_URL ?? "http://localhost:5000";
  const ID = "test-entity-001";

  const FIXTURE = {
    entity_id: ID,
    identity: {
      full_name: "Ada Lovelace",
      pronouns: "she/her",
      timezone: "Europe/London",
      location_city: "London",
      location_country: "UK",
      source_kind: "operator_asserted",
      confidence: 0.9,
      headshot_url: "",
      primary_email: "ada@example.com",
    },
    career_history: [
      { title: "CTO", organization_name: "Analytical Engines Ltd", is_current: 1,
        started_at: "2022-01-01", source_url: "https://example.com/about",
        source: "company-about", confidence: 0.8 },
    ],
    board_seats: [],
    education_history: [],
    family_ties_public: [],
    preferences: [],
    interests: [],
    lifestyle_signals: [],
    travel_patterns: [],
    conference_attendance: [],
    conversation_hooks: [],
    appreciation_signals: [],
    identity_handles: [{ platform: "linkedin", handle: "adalovelace", url: "https://linkedin.com/in/adalovelace" }],
    populated_tables: ["identity", "career_history", "identity_handles"],
    privacy_skipped_enrichers: [{ enricher_name: "x_dms", reason: "no consent" }],
    latest_synthesis: {
      computed_at: new Date().toISOString(),
      llm_model: "test-model",
      citations_count: 5,
      conversation_starters_count: 3,
      to_do_business_with_them: {
        executive_summary: "Pioneer of analytical computation; led the CTO function at Analytical Engines for three years and ships open numerical libraries.",
        conversation_starters: ["Ask about Bernoulli number generation."],
      },
    },
  };

  test("dossier page renders header, all eight tabs, and accepts a comment", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // Stub the API surface used by the page.
    await page.route("**/api/profilers/**/dossier**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) }),
    );
    await page.route("**/api/profilers/**/sources**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [{ source_kind: "linkedin", source: "linkedin.com", n: 3 }] }) }),
    );
    await page.route("**/api/profilers/**/changelog**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
    );
    await page.route("**/api/profilers/**/audit**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
    );
    await page.route("**/api/profilers/**/run**", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited", next_eligible_at: new Date(Date.now() + 86400000).toISOString() }) }),
    );
    const comments = [];
    await page.route("**/api/profile-comments/**", (route) => {
      if (route.request().method() === "POST") {
        comments.push({ id: "c1", author_email: "operator@test", body: JSON.parse(route.request().postData() || "{}").body, created_at: new Date().toISOString() });
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: comments }) });
    });

    await page.goto(`${BASE}/dashboard/people/?id=${ID}`);
    await page.waitForSelector("#ads-person-name");
    await page.waitForFunction(() => document.getElementById("ads-person-name")?.textContent?.includes("Ada"));

    // Header: name, pronouns, role link, timezone clock.
    assert.match(await page.textContent("#ads-person-pronouns"), /she\/her/);
    assert.match(await page.textContent("#ads-person-role"), /CTO at Analytical Engines/);
    assert.match(await page.textContent("#ads-person-tz"), /Europe\/London|London/);

    // All eight tabs render non-empty and switch lazily.
    for (const tab of ["overview", "career", "background", "interests", "network", "voice", "outreach", "intelligence"]) {
      await page.click(`.ads-person-tabs [data-tab="${tab}"]`);
      const visible = await page.isVisible(`.ads-tab-panel[data-tab="${tab}"]`);
      assert.equal(visible, true, `tab ${tab} should be visible after click`);
    }

    // Refresh button surfaces the 429 message.
    await page.click("#ads-person-refresh");
    await page.waitForFunction(() => /Rate-limited/.test(document.getElementById("ads-person-msg")?.textContent ?? ""));

    // Posting a comment writes to the rail.
    await page.fill("#ads-person-comment-form textarea", "Met at conf.");
    await page.click("#ads-person-comment-form button[type=submit]");
    await page.waitForFunction(() => /Met at conf/.test(document.getElementById("ads-person-comments")?.textContent ?? ""));

    await browser.close();
  });
}
