// Task #53: comp-panel snapshot batches the per-member valuation-marks
// lookup into ONE query. These tests drive the real Hono route handler
// against a fake D1 that records every prepared SQL string, proving:
//   (1) exactly one query touches valuation_marks regardless of how many
//       private members the panel has (the prior N+1 is gone), and
//   (2) the snapshot output is identical to the per-member version —
//       public metrics, private latest_mark + inferred range, and medians.

import { test } from "node:test";
import assert from "node:assert/strict";

const { compPanelsRoute } = await import("../test-dist/routes/valuation.js");

// Build a fake D1 whose prepare() records the SQL and whose first()/all()
// dispatch on which table the query targets.
function makeEnv({ panel, members, marks, sqlLog }) {
  return {
    DB: {
      prepare(sql) {
        sqlLog.push(sql);
        return {
          bind() { return this; },
          async first() {
            if (/FROM comp_panels WHERE id/.test(sql)) return panel;
            return null;
          },
          async all() {
            if (/FROM comp_members m/.test(sql)) return { results: members };
            if (/valuation_marks/.test(sql)) return { results: marks };
            return { results: [] };
          },
        };
      },
    },
  };
}

const PANEL = {
  id: "p1", name: "VSaaS", description: "vertical saas",
  criteria_json: JSON.stringify({ sector: "vertical_saas" }),
  last_refreshed_at: "2026-06-01T00:00:00Z", member_count: 3,
};

function publicMember(id, evArr, evRev) {
  return {
    company_entity_id: id, company_name_raw: id.toUpperCase(), is_public: 1,
    ticker: "TCK", match_reason: "sector",
    revenue_usd: 100, arr_usd: 80, growth_yoy_pct: 0.5, gross_margin_pct: 0.7,
    rule_of_40_pct: 0.6, ev_revenue_multiple: evRev, ev_arr_multiple: evArr,
    enterprise_value_usd: 1000, quarter_end: "2026-03-31",
  };
}
function privateMember(id) {
  return {
    company_entity_id: id, company_name_raw: id.toUpperCase(), is_public: 0,
    ticker: null, match_reason: "sector",
    revenue_usd: null, arr_usd: null, growth_yoy_pct: null, gross_margin_pct: null,
    rule_of_40_pct: null, ev_revenue_multiple: null, ev_arr_multiple: null,
    enterprise_value_usd: null, quarter_end: null,
  };
}

test("snapshot issues exactly ONE valuation_marks query for many private members", async () => {
  const sqlLog = [];
  const env = makeEnv({
    panel: PANEL,
    members: [publicMember("pub1", 12, 10), privateMember("pv1"), privateMember("pv2"), privateMember("pv3")],
    marks: [
      { company_entity_id: "pv1", implied_valuation_usd: 500, as_of: "2026-01-01", source_kind: "filing", confidence: 0.9 },
      { company_entity_id: "pv2", implied_valuation_usd: 200, as_of: "2026-02-01", source_kind: "inferred", confidence: 0.5 },
      // pv3 intentionally has no mark
    ],
    sqlLog,
  });
  const res = await compPanelsRoute.request("/p1/snapshot", {}, env);
  assert.equal(res.status, 200);
  const marksQueries = sqlLog.filter((s) => /valuation_marks/.test(s));
  assert.equal(marksQueries.length, 1, "expected a single batched valuation_marks query");
  // The batched query must be the windowed top-mark-per-company form.
  assert.match(marksQueries[0], /ROW_NUMBER\(\)\s+OVER/i);
  assert.match(marksQueries[0], /PARTITION BY vm\.company_entity_id/);
});

test("snapshot output identical to per-member version: marks, inferred range, medians", async () => {
  const sqlLog = [];
  const env = makeEnv({
    panel: PANEL,
    members: [publicMember("pub1", 12, 10), publicMember("pub2", 8, 6), privateMember("pv1"), privateMember("pv2")],
    marks: [
      { company_entity_id: "pv1", implied_valuation_usd: 500, as_of: "2026-01-01", source_kind: "filing", confidence: 0.9 },
      // pv2 has no mark → null latest_mark + null inferred range
    ],
    sqlLog,
  });
  const res = await compPanelsRoute.request("/p1/snapshot", {}, env);
  const body = await res.json();

  assert.equal(body.panel_id, "p1");
  assert.deepEqual(body.criteria, { sector: "vertical_saas" });

  const byId = Object.fromEntries(body.members.map((m) => [m.company_entity_id, m]));

  // Public member keeps its metrics, no inferred range.
  assert.equal(byId.pub1.ev_arr_multiple, 12);
  assert.equal(byId.pub1.inferred_valuation_low_usd, null);

  // Private with a mark: latest_mark shape + 0.7/1.3 inferred band.
  assert.deepEqual(byId.pv1.latest_mark, {
    implied_valuation_usd: 500, as_of: "2026-01-01", source_kind: "filing", confidence: 0.9,
  });
  assert.equal(byId.pv1.inferred_valuation_low_usd, Math.round(500 * 0.7));
  assert.equal(byId.pv1.inferred_valuation_high_usd, Math.round(500 * 1.3));
  assert.equal(byId.pv1.revenue_usd, null);

  // Private without a mark: null mark + null band (no fabricated number).
  assert.equal(byId.pv2.latest_mark, null);
  assert.equal(byId.pv2.inferred_valuation_low_usd, null);
  assert.equal(byId.pv2.inferred_valuation_high_usd, null);

  // Medians computed from public members only (12,8 → 12; 10,6 → 10).
  assert.equal(body.medians.ev_arr, 12);
  assert.equal(body.medians.ev_revenue, 10);
});
