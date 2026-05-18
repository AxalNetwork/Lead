// Task #3: Strategy drift detector.
//
// Per spec: compute drift PER FUND PER MONTH on a rolling 6-month
// window of actual portfolio activity vs the fund's declared
// strategy/sectors (or, when no declared sectors exist, vs the same
// fund's earlier 6-month window). Stamps `fund.strategy_drift` on the
// FUND entity via canonical insertFact when drift_score >= 0.4. Also
// returns the most recent month's report for the API layer.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { buildFundPortfolio } from "./portfolio";
import type { FundRow } from "./types";

export interface MonthlyDriftReport {
  fund_id: string;
  month: string;                       // ISO YYYY-MM
  sector_jaccard_vs_declared: number;  // 0..1 distance vs declared sectors
  sector_jaccard_vs_prior_6mo: number; // 0..1 distance vs prior 6-month window
  stage_modal: string | null;
  stage_drift_from_prior: boolean;
  position_count: number;
  drift_score: number;
  signals: string[];
}

function jaccardDistance(a: string[], b: string[]): number {
  const A = new Set(a.map((x) => x.toLowerCase()));
  const B = new Set(b.map((x) => x.toLowerCase()));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return 1 - (inter / union);
}

function modalRoundName(positions: { round_name: string | null }[]): string | null {
  const counts: Record<string, number> = {};
  for (const p of positions) {
    if (!p.round_name) continue;
    counts[p.round_name] = (counts[p.round_name] ?? 0) + 1;
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function topN(map: Record<string, number>, n: number): string[] {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/** Months covered by a fund's portfolio (oldest position month →
 *  latest position month inclusive). Bounded to last 24 months when
 *  the window is wider — drift is only meaningful on recent activity. */
function monthsCovered(positions: { date: string | null }[]): string[] {
  const months = new Set<string>();
  for (const p of positions) {
    if (!p.date) continue;
    months.add(p.date.slice(0, 7));
  }
  const sorted = [...months].sort();
  if (sorted.length <= 24) return sorted;
  return sorted.slice(-24);
}

function addMonths(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

function loadFundDeclaredSectors(fund: FundRow): string[] {
  if (!fund.sectors_json) return [];
  try {
    const parsed = JSON.parse(fund.sectors_json) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch { /* ignore */ }
  return [];
}

/**
 * Compute rolling-6-month drift for one fund, per month. For each
 * month with portfolio activity:
 *   - sector mix over [month-6mo, month]  vs declared sectors → jaccard
 *   - sector mix over [month-6mo, month]  vs [month-12mo, month-6mo] → jaccard
 *   - modal round_name vs prior window's modal → stage change flag
 * drift_score = 0.5 × max(sector_vs_declared, sector_vs_prior) +
 *               0.3 × stage_change +
 *               0.2 × (count-of-prior-window > 0 ? 0 : 0)  (placeholder)
 *
 * When drift_score ≥ 0.4, stamps a `fund.strategy_drift` fact on the
 * FUND entity (when resolved) via the canonical insertFact path.
 * Returns ALL monthly reports for the API layer.
 */
export async function computeStrategyDrift(env: Env, fundId: string): Promise<MonthlyDriftReport[]> {
  const fund = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, fund_number,
            vintage_year, target_size_usd, hard_cap_usd, first_close_date,
            final_close_date, announced_raised_usd, gp_commit_usd,
            mgmt_fee_pct, carry_pct, hurdle_pct, strategy, sectors_json,
            geos_json, fund_status, source_evidence_json, confidence,
            updated_at, created_at
       FROM funds WHERE id = ?`,
  ).bind(fundId).first<FundRow>();
  if (!fund) return [];

  const port = await buildFundPortfolio(env, fund.id);
  if (!port || port.positions.length === 0) return [];
  const declared = loadFundDeclaredSectors(fund);
  const months = monthsCovered(port.positions);

  const reports: MonthlyDriftReport[] = [];
  let prevModal: string | null = null;

  for (const month of months) {
    const winStart = addMonths(month, -6);
    const priorEnd = addMonths(month, -6);
    const priorStart = addMonths(month, -12);

    const window = port.positions.filter((p) => p.date && p.date.slice(0, 7) > winStart && p.date.slice(0, 7) <= month);
    const prior  = port.positions.filter((p) => p.date && p.date.slice(0, 7) > priorStart && p.date.slice(0, 7) <= priorEnd);
    if (window.length === 0) continue;

    const winSectors: Record<string, number> = {};
    for (const p of window) for (const s of p.sector_tags) winSectors[s] = (winSectors[s] ?? 0) + 1;
    const priorSectors: Record<string, number> = {};
    for (const p of prior) for (const s of p.sector_tags) priorSectors[s] = (priorSectors[s] ?? 0) + 1;

    const sectorVsDeclared = declared.length > 0
      ? jaccardDistance(topN(winSectors, 5), declared)
      : 0;
    const sectorVsPrior = prior.length > 0
      ? jaccardDistance(topN(winSectors, 5), topN(priorSectors, 5))
      : 0;

    const stageNow = modalRoundName(window);
    const stageDriftFromPrior = !!(stageNow && prevModal && stageNow.toLowerCase() !== prevModal.toLowerCase());

    const signals: string[] = [];
    if (declared.length > 0 && sectorVsDeclared >= 0.5) {
      signals.push(`sector_drift_vs_declared: jaccard=${sectorVsDeclared.toFixed(2)}`);
    }
    if (sectorVsPrior >= 0.5) signals.push(`sector_drift_rolling: jaccard=${sectorVsPrior.toFixed(2)}`);
    if (stageDriftFromPrior) signals.push(`stage_drift: ${prevModal} → ${stageNow}`);

    const driftScore =
      0.5 * Math.max(sectorVsDeclared, sectorVsPrior) +
      (stageDriftFromPrior ? 0.3 : 0);

    const report: MonthlyDriftReport = {
      fund_id: fund.id,
      month,
      sector_jaccard_vs_declared: Number(sectorVsDeclared.toFixed(3)),
      sector_jaccard_vs_prior_6mo: Number(sectorVsPrior.toFixed(3)),
      stage_modal: stageNow,
      stage_drift_from_prior: stageDriftFromPrior,
      position_count: window.length,
      drift_score: Number(driftScore.toFixed(3)),
      signals,
    };
    reports.push(report);

    if (driftScore >= 0.4) {
      // Prefer the fund entity; fall back to the GP firm entity so
      // drift facts are still emitted for legacy funds rows that
      // pre-date the fund_entity_id link.
      const target = fund.fund_entity_id ?? fund.firm_entity_id;
      if (target) {
        await insertFact(env, {
          entity_id: target,
          predicate: fund.fund_entity_id ? "fund.strategy_drift" : "firm.strategy_drift",
          source_kind: "scrape",
          source: "fund_strategy_drift",
          value_json: { ...report, fallback_to_firm: !fund.fund_entity_id },
          confidence: 0.7,
          evidence_url: null,
        });
      }
    }
    prevModal = stageNow ?? prevModal;
  }

  return reports;
}
