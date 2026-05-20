// Task #10: Dossiers dashboard aggregator + PDF export.
//
//   GET /api/dossiers/:id        — one-payload synthesis of every
//                                  surface the platform already
//                                  produces for an entity.
//   GET /api/dossiers/:id/pdf    — same payload rendered through the
//                                  canonical buildPdf / pdfResponse
//                                  pipeline (Task #4 PDF decision —
//                                  no parallel renderer).
//   GET /api/dossiers/search?q=  — name search for the entity picker.
//
// Read-only over existing tables; no fact writes, no schema changes.
// Every section read is wrapped in try/catch so a cold install
// without Task #2/#3/#4/#14/#18 tables degrades to an empty section
// rather than 500-ing the whole page (same pattern as the Task #9
// predictions aggregator).

import { Hono } from "hono";
import type { Env } from "../types";
import { pdfResponse } from "./dashboards_pdf";

export const dossiersRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

interface IdentityRow {
  id: string;
  kind: string | null;
  display_name: string | null;
  primary_url: string | null;
  primary_domain: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

async function loadDossier(env: Env, id: string) {
  const identity = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain, status, created_at, updated_at
       FROM u_entities WHERE id = ?`,
  ).bind(id).first<IdentityRow>().catch(() => null);

  if (!identity) return null;

  // Section: verification findings (Task #14). Append-only chain;
  // is_current=1 is the live state. Empty array on missing table.
  let verification: unknown[] = [];
  let verificationState: unknown = null;
  try {
    const r = await env.DB.prepare(
      `SELECT claim_predicate, claim_summary, verifier_name, status,
              confidence, evidence_url, reason, created_at
         FROM verification_findings
        WHERE person_entity_id = ? AND is_current = 1
        ORDER BY status, created_at DESC
        LIMIT 25`,
    ).bind(id).all();
    verification = r.results ?? [];
  } catch { verification = []; }
  try {
    verificationState = await env.DB.prepare(
      `SELECT last_verified_at, last_viewed_at FROM person_verification_state WHERE entity_id = ?`,
    ).bind(id).first();
  } catch { verificationState = null; }

  // Section: holdings — outbound investment-style edges (kind in
  // invested_in / co_invested_with / led_round). Reads rel_edges
  // directly; degrades to empty on missing table.
  let holdings: unknown[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT re.kind, re.dst_entity_id AS other_id, re.quality_score,
              re.last_interaction_at, re.evidence_url,
              u.display_name AS other_name, u.kind AS other_kind
         FROM rel_edges re
         LEFT JOIN u_entities u ON u.id = re.dst_entity_id
        WHERE re.src_entity_id = ?
          AND re.kind IN ('invested_in','co_invested_with','led_round','holds_position_in')
        ORDER BY re.quality_score DESC NULLS LAST, re.last_interaction_at DESC NULLS LAST
        LIMIT 25`,
    ).bind(id).all();
    holdings = r.results ?? [];
  } catch { holdings = []; }

  // Section: term aggressiveness (Task #18). The entity could be a
  // company (has preferred_series rows) or an investor (has weighted
  // aggressiveness score from preferred_series_investors). We do a
  // SQL-only read here rather than calling computeInvestorAggressiveness
  // because the dossier is a read-only synthesis, not a derivation —
  // anything not already in the table is reported as missing.
  let preferredSeries: unknown[] = [];
  let investorTermsAvg: { avg_lp_x: number | null; series_count: number; aggressive_count: number } | null = null;
  try {
    const r = await env.DB.prepare(
      `SELECT series_name, stage, sector, closing_date,
              liquidation_pref_x, participating, participating_cap_x, anti_dilution,
              pre_money_usd, post_money_usd
         FROM preferred_series
        WHERE company_entity_id = ? AND is_current = 1
        ORDER BY COALESCE(closing_date,'') DESC
        LIMIT 10`,
    ).bind(id).all();
    preferredSeries = r.results ?? [];
  } catch { preferredSeries = []; }
  try {
    const r = await env.DB.prepare(
      `SELECT AVG(ps.liquidation_pref_x) AS avg_lp_x,
              COUNT(*) AS series_count,
              SUM(CASE WHEN ps.liquidation_pref_x > 1 OR ps.participating = 1 OR ps.anti_dilution = 'full_ratchet' THEN 1 ELSE 0 END) AS aggressive_count
         FROM preferred_series_investors psi
         JOIN preferred_series ps ON ps.id = psi.series_id
        WHERE psi.investor_entity_id = ? AND ps.is_current = 1`,
    ).bind(id).first<{ avg_lp_x: number | null; series_count: number; aggressive_count: number }>();
    if (r && r.series_count > 0) investorTermsAvg = r;
  } catch { investorTermsAvg = null; }

  // Section: intro paths (Task #4). Top-3 most-recent paths targeting
  // this entity, ranked by predicted_conversion_pct. We don't filter
  // by viewer here because the dossier is the operator's offline
  // artifact; existing access guard at /api/* governs who can read.
  let intros: unknown[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id AS path_id, hops, predicted_conversion_pct, ranking_mode,
              weakest_edge_quality, suggested_opener, created_at
         FROM intro_paths
        WHERE target_entity_id = ?
        ORDER BY (predicted_conversion_pct IS NULL),
                 predicted_conversion_pct DESC,
                 created_at DESC
        LIMIT 3`,
    ).bind(id).all();
    intros = r.results ?? [];
  } catch { intros = []; }

  // Section: top-10 relationships by quality_score (Task #3).
  let relationships: unknown[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT re.id, re.kind, re.quality_score, re.last_interaction_at,
              CASE WHEN re.src_entity_id = ? THEN re.dst_entity_id ELSE re.src_entity_id END AS other_id,
              u.display_name AS other_name
         FROM rel_edges re
         LEFT JOIN u_entities u ON u.id = (CASE WHEN re.src_entity_id = ? THEN re.dst_entity_id ELSE re.src_entity_id END)
        WHERE (re.src_entity_id = ? OR re.dst_entity_id = ?)
        ORDER BY re.quality_score DESC NULLS LAST
        LIMIT 10`,
    ).bind(id, id, id, id).all();
    relationships = r.results ?? [];
  } catch { relationships = []; }

  // Section: influence (Task #3) — pagerank / broker / power-node flag.
  let influence: unknown = null;
  try {
    influence = await env.DB.prepare(
      `SELECT pagerank_score, broker_score, is_power_node,
              primary_sector, total_degree, computed_at
         FROM entity_influence WHERE entity_id = ?`,
    ).bind(id).first();
  } catch { influence = null; }

  // Section: 10 most-recent verified facts. Verified = verified_score
  // is set (the crossRef-promoted contract from Task #1 — unverified
  // raw rows must NOT appear in the dossier per the task spec).
  let recentFacts: unknown[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT predicate, value_text, value_number, source, source_kind,
              confidence, verified_score, evidence_url, observed_at
         FROM facts
        WHERE entity_id = ? AND is_current = 1 AND verified_score IS NOT NULL
        ORDER BY observed_at DESC
        LIMIT 10`,
    ).bind(id).all();
    recentFacts = r.results ?? [];
  } catch { recentFacts = []; }

  return {
    identity,
    verification: { items: verification, state: verificationState },
    holdings: { items: holdings },
    term_aggressiveness: {
      preferred_series: preferredSeries,
      investor_terms_avg: investorTermsAvg,
    },
    intros: { items: intros },
    relationships: { items: relationships },
    influence,
    recent_facts: { items: recentFacts },
    generated_at: new Date().toISOString(),
  };
}

dossiersRoute.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ items: [] });
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, display_name, kind, primary_domain
         FROM u_entities
        WHERE status = 'active'
          AND display_name IS NOT NULL
          AND LOWER(display_name) LIKE ?
        ORDER BY display_name
        LIMIT 20`,
    ).bind("%" + q.toLowerCase() + "%").all();
    return c.json({ items: r.results ?? [] });
  } catch {
    return c.json({ items: [] });
  }
});

dossiersRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const data = await loadDossier(c.env, id);
  if (!data) return c.json({ error: "entity_not_found" }, 404);
  return c.json(data);
});

// PDF export — reuses the canonical buildPdf builder (Task #4
// decision). The dossier is a multi-section artifact, so we flatten
// each section into the same headers/rows table shape the diligence
// report uses; section headers ride as a synthetic row at the top of
// each block. 140-char per-cell clip honored by buildPdf via its
// charsPerCol calculation.
dossiersRoute.get("/:id/pdf", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const data = await loadDossier(c.env, id);
  if (!data) return c.json({ error: "entity_not_found" }, 404);

  type R = Record<string, unknown>;
  const headers = ["Section", "Field", "Value", "Source"];
  const rows: R[] = [];
  const push = (Section: string, Field: string, Value: unknown, Source: unknown = "") => {
    rows.push({ Section, Field, Value: Value == null ? "" : String(Value), Source: Source == null ? "" : String(Source) });
  };

  // Identity.
  push("Identity", "Name", data.identity.display_name ?? "—");
  push("Identity", "Kind", data.identity.kind ?? "—");
  push("Identity", "Domain", data.identity.primary_domain ?? "—");
  push("Identity", "URL", data.identity.primary_url ?? "—");
  push("Identity", "Status", data.identity.status ?? "—");

  // Verification.
  if (data.verification.items.length === 0) {
    push("Verification", "—", "no findings yet");
  } else {
    for (const v of data.verification.items as R[]) {
      push("Verification", String(v.claim_predicate ?? ""), `${v.status} (${v.confidence ?? "—"}) — ${v.claim_summary ?? ""}`, v.verifier_name);
    }
  }

  // Holdings.
  if (data.holdings.items.length === 0) {
    push("Holdings", "—", "no holdings yet");
  } else {
    for (const h of data.holdings.items as R[]) {
      push("Holdings", String(h.kind ?? ""), String(h.other_name ?? h.other_id ?? ""), h.evidence_url ?? "");
    }
  }

  // Term aggressiveness.
  const ps = data.term_aggressiveness.preferred_series as R[];
  const ita = data.term_aggressiveness.investor_terms_avg as { avg_lp_x: number | null; series_count: number; aggressive_count: number } | null;
  if (ps.length === 0 && !ita) {
    push("Term aggressiveness", "—", "no term data yet");
  } else {
    for (const s of ps) {
      push("Term aggressiveness", String(s.series_name ?? ""), `LP ${s.liquidation_pref_x ?? "—"}x · ${s.anti_dilution ?? ""} · ${s.participating ? "participating" : "non-participating"}`, s.closing_date ?? "");
    }
    if (ita) {
      push("Term aggressiveness", "Investor avg LP×", String(ita.avg_lp_x ?? "—"), `${ita.aggressive_count}/${ita.series_count} aggressive`);
    }
  }

  // Intros.
  if (data.intros.items.length === 0) {
    push("Intro paths", "—", "no intro paths yet");
  } else {
    for (const p of data.intros.items as R[]) {
      const pct = p.predicted_conversion_pct == null
        ? "hop-count ranked"
        : `${Math.round(Number(p.predicted_conversion_pct) * 1000) / 10}% predicted`;
      push("Intro paths", `${p.hops} hop${Number(p.hops) > 1 ? "s" : ""}`, pct, p.ranking_mode);
    }
  }

  // Top relationships.
  if (data.relationships.items.length === 0) {
    push("Top relationships", "—", "no relationship edges yet");
  } else {
    for (const r of data.relationships.items as R[]) {
      push("Top relationships", String(r.kind ?? ""), String(r.other_name ?? r.other_id ?? ""), `q=${r.quality_score ?? "—"}`);
    }
  }

  // Influence.
  if (!data.influence) {
    push("Influence", "—", "no influence row yet");
  } else {
    const inf = data.influence as R;
    push("Influence", "PageRank", String(inf.pagerank_score ?? "—"));
    push("Influence", "Broker score", String(inf.broker_score ?? "—"));
    push("Influence", "Power node", inf.is_power_node ? "yes" : "no");
    push("Influence", "Primary sector", inf.primary_sector ?? "—");
  }

  // Recent facts.
  if (data.recent_facts.items.length === 0) {
    push("Recent facts", "—", "no facts yet");
  } else {
    for (const f of data.recent_facts.items as R[]) {
      const v = f.value_text ?? f.value_number ?? "";
      push("Recent facts", String(f.predicate ?? ""), String(v), `${f.source ?? ""}`);
    }
  }

  const title = `Dossier — ${data.identity.display_name ?? id}`;
  const subtitle = `Generated ${data.generated_at} · ${data.identity.kind ?? "entity"} · ${data.identity.primary_domain ?? ""}`;
  const filename = `dossier-${id}`;
  // Reuses the canonical pdfResponse helper per the Task #4
  // PDF-pipeline decision — no parallel renderer.
  return pdfResponse(rows, headers, filename, title, subtitle);
});
