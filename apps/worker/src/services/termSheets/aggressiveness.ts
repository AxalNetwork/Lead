// Task #18: Term-aggressiveness scoring.
//
// One weighted index per series; the per-investor score is the mean
// of every series an investor was attributed to (lead or follower).
// "Lead" attribution gets 1.5x weight so a fund's own lead deals
// dominate the score vs. minority co-investments.
//
// Aggression scale 0..1 (higher = more founder-unfriendly):
//   liquidation_pref_x      → 0 @ 1x, 0.25 @ 1.5x, 0.5 @ 2x, 1.0 @ ≥3x
//   participating           → +0.25 if true (uncapped: +0.4)
//   anti_dilution           → 0 broad / 0.4 narrow / 1.0 full_ratchet / 0 none
//   protective_provisions   → 0.02 per item beyond 5 (capped at 0.3)
//   redemption_rights       → +0.15 if true
//   board_investor_seats    → +0.15 when investor seats ≥ founder seats
//
// Weights are normalized so the per-term breakdown sums to 1.
//
// Feeds Task #119 (investor reputation) when that lands; until then,
// the endpoint is self-contained per Task #18 architectural note.

import type { Env } from "../../types";

export interface PerTermContribution {
  term: string;
  value: number;
  weight: number;
  raw: number | string | boolean | null;
}

export interface SeriesAggressiveness {
  series_id: string;
  series_name: string;
  company_entity_id: string;
  score: number;             // 0..1
  breakdown: PerTermContribution[];
}

const TERM_WEIGHTS = {
  liquidation_pref_x: 0.25,
  participating: 0.20,
  anti_dilution: 0.25,
  protective_provisions_count: 0.10,
  redemption_rights: 0.10,
  board_investor_seats: 0.10,
} as const;

function lpToScore(x: number | null): number {
  if (x == null) return 0;
  if (x <= 1) return 0;
  if (x <= 1.5) return 0.25;
  if (x <= 2) return 0.5;
  if (x <= 2.5) return 0.75;
  return 1;
}
function antiToScore(a: string | null): number {
  if (a === "full_ratchet") return 1;
  if (a === "narrow_weighted") return 0.4;
  return 0;
}

interface SeriesScoreInput {
  id: string;
  series_name: string;
  company_entity_id: string;
  liquidation_pref_x: number | null;
  participating: number | null;
  participating_cap_x: number | null;
  anti_dilution: string | null;
  protective_provisions_count: number | null;
  redemption_rights: number | null;
  board_investor_seats: number | null;
  board_founder_seats: number | null;
}

export function scoreSeries(s: SeriesScoreInput): SeriesAggressiveness {
  const breakdown: PerTermContribution[] = [];
  const push = (term: string, raw: number | string | boolean | null, value: number, weight: number) => {
    breakdown.push({ term, raw, value, weight });
  };
  push("liquidation_pref_x", s.liquidation_pref_x, lpToScore(s.liquidation_pref_x), TERM_WEIGHTS.liquidation_pref_x);
  let partVal = 0;
  if (s.participating === 1) {
    partVal = s.participating_cap_x == null ? 1.0 : 0.5;
  }
  push("participating", s.participating === 1, partVal, TERM_WEIGHTS.participating);
  push("anti_dilution", s.anti_dilution, antiToScore(s.anti_dilution), TERM_WEIGHTS.anti_dilution);
  const ppExcess = s.protective_provisions_count != null ? Math.max(0, s.protective_provisions_count - 5) : 0;
  push("protective_provisions_count", s.protective_provisions_count, Math.min(1, ppExcess * 0.1), TERM_WEIGHTS.protective_provisions_count);
  push("redemption_rights", s.redemption_rights === 1, s.redemption_rights === 1 ? 1 : 0, TERM_WEIGHTS.redemption_rights);
  const boardVal = (s.board_investor_seats != null && s.board_founder_seats != null && s.board_investor_seats >= s.board_founder_seats) ? 1 : 0;
  push("board_investor_seats", s.board_investor_seats, boardVal, TERM_WEIGHTS.board_investor_seats);
  const score = Number(breakdown.reduce((a, b) => a + b.value * b.weight, 0).toFixed(4));
  return { series_id: s.id, series_name: s.series_name, company_entity_id: s.company_entity_id, score, breakdown };
}

export interface InvestorAggressiveness {
  investor_entity_id: string;
  series_count: number;
  lead_count: number;
  score: number;                            // weighted mean 0..1
  per_term_means: Record<string, number>;   // mean per-term contribution across the investor's portfolio
  series: Array<{ series_id: string; company_entity_id: string; series_name: string; score: number; is_lead: boolean }>;
}

export async function computeInvestorAggressiveness(env: Env, investorEntityId: string): Promise<InvestorAggressiveness> {
  const r = await env.DB.prepare(
    `SELECT ps.id, ps.series_name, ps.company_entity_id,
            ps.liquidation_pref_x, ps.participating, ps.participating_cap_x,
            ps.anti_dilution, ps.protective_provisions_count, ps.redemption_rights,
            ps.board_investor_seats, ps.board_founder_seats,
            psi.is_lead
       FROM preferred_series_investors psi
       JOIN preferred_series ps ON ps.id = psi.series_id
      WHERE psi.investor_entity_id = ? AND ps.is_current = 1`,
  ).bind(investorEntityId).all<SeriesScoreInput & { is_lead: number }>();
  const rows = r.results ?? [];
  if (!rows.length) {
    return { investor_entity_id: investorEntityId, series_count: 0, lead_count: 0, score: 0, per_term_means: {}, series: [] };
  }
  const scored = rows.map((row) => ({ ...scoreSeries(row), is_lead: row.is_lead === 1 }));
  const totalW = scored.reduce((a, s) => a + (s.is_lead ? 1.5 : 1), 0);
  const score = Number((scored.reduce((a, s) => a + s.score * (s.is_lead ? 1.5 : 1), 0) / totalW).toFixed(4));
  const termSums: Record<string, { sum: number; n: number }> = {};
  for (const s of scored) {
    for (const b of s.breakdown) {
      if (!termSums[b.term]) termSums[b.term] = { sum: 0, n: 0 };
      termSums[b.term].sum += b.value;
      termSums[b.term].n += 1;
    }
  }
  const per_term_means: Record<string, number> = {};
  for (const t of Object.keys(termSums)) {
    per_term_means[t] = Number((termSums[t].sum / termSums[t].n).toFixed(4));
  }
  return {
    investor_entity_id: investorEntityId,
    series_count: scored.length,
    lead_count: scored.filter((s) => s.is_lead).length,
    score,
    per_term_means,
    series: scored.map((s) => ({
      series_id: s.series_id, company_entity_id: s.company_entity_id,
      series_name: s.series_name, score: s.score, is_lead: s.is_lead,
    })),
  };
}
