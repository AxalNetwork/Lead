// Task #3: Strategy drift detector.
//
// Compares a firm's most-recent fund's portfolio (or its declared
// strategy) to the previous fund(s). Detects:
//   - stage drift (e.g. Seed → Growth) by comparing modal round_name
//   - sector drift by Jaccard distance on top-5 sector tags
//   - geo drift by Jaccard distance on top-3 geographies
//   - size drift by raised-USD ratio
//
// Emits `firm.strategy_drift` facts via canonical insertFact when a
// drift is detected (drift_score ≥ 0.4). Read by the
// /api/funds/raising-now and /api/firms/:id/funds endpoints.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { buildFundPortfolio } from "./portfolio";
import type { FundRow } from "./types";

export interface DriftReport {
  firm_entity_id: string;
  current_fund_id: string;
  previous_fund_id: string | null;
  stage_drift: { from: string | null; to: string | null; changed: boolean };
  sector_drift_jaccard: number;
  geo_drift_jaccard: number;
  size_ratio: number | null;
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

export async function computeStrategyDrift(env: Env, firmEntityId: string): Promise<DriftReport | null> {
  const fundsRes = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, fund_number,
            vintage_year, target_size_usd, hard_cap_usd, first_close_date,
            final_close_date, announced_raised_usd, gp_commit_usd,
            mgmt_fee_pct, carry_pct, hurdle_pct, strategy, sectors_json,
            geos_json, fund_status, source_evidence_json, confidence,
            updated_at, created_at
       FROM funds
      WHERE firm_entity_id = ?
      ORDER BY COALESCE(vintage_year, 0) DESC, COALESCE(fund_number, 0) DESC
      LIMIT 5`,
  ).bind(firmEntityId).all<FundRow>();
  const funds = fundsRes.results ?? [];
  if (funds.length === 0) return null;
  const current = funds[0];
  const previous = funds[1] ?? null;
  const signals: string[] = [];

  const currentPort = await buildFundPortfolio(env, current.id);
  if (!currentPort) return null;
  const previousPort = previous ? await buildFundPortfolio(env, previous.id) : null;

  const stageNow = modalRoundName(currentPort.positions);
  const stageBefore = previousPort ? modalRoundName(previousPort.positions) : null;
  const stageChanged = !!(stageNow && stageBefore && stageNow.toLowerCase() !== stageBefore.toLowerCase());
  if (stageChanged) signals.push(`stage_drift: ${stageBefore} → ${stageNow}`);

  const sectorJac = previousPort
    ? jaccardDistance(topN(currentPort.summary.sector_breakdown, 5), topN(previousPort.summary.sector_breakdown, 5))
    : 0;
  if (sectorJac >= 0.5) signals.push(`sector_drift: jaccard=${sectorJac.toFixed(2)}`);

  const geoJac = previousPort
    ? jaccardDistance(topN(currentPort.summary.geography_breakdown, 3), topN(previousPort.summary.geography_breakdown, 3))
    : 0;
  if (geoJac >= 0.5) signals.push(`geo_drift: jaccard=${geoJac.toFixed(2)}`);

  let sizeRatio: number | null = null;
  if (previous && previous.announced_raised_usd && current.announced_raised_usd && previous.announced_raised_usd > 0) {
    sizeRatio = current.announced_raised_usd / previous.announced_raised_usd;
    if (sizeRatio >= 1.8 || sizeRatio <= 0.5) {
      signals.push(`size_drift: ratio=${sizeRatio.toFixed(2)}× previous fund`);
    }
  }

  const driftScore =
    (stageChanged ? 0.4 : 0) +
    0.3 * sectorJac +
    0.2 * geoJac +
    (sizeRatio != null && (sizeRatio >= 1.8 || sizeRatio <= 0.5) ? 0.2 : 0);

  if (driftScore >= 0.4) {
    await insertFact(env, {
      entity_id: firmEntityId,
      predicate: "firm.strategy_drift",
      source_kind: "scrape",
      source: "fund_strategy_drift",
      value_json: {
        current_fund_id: current.id,
        previous_fund_id: previous?.id ?? null,
        drift_score: Number(driftScore.toFixed(3)),
        stage: { from: stageBefore, to: stageNow },
        sector_jaccard: Number(sectorJac.toFixed(3)),
        geo_jaccard: Number(geoJac.toFixed(3)),
        size_ratio: sizeRatio,
        signals,
      },
      confidence: 0.7,
      evidence_url: null,
    });
  }

  return {
    firm_entity_id: firmEntityId,
    current_fund_id: current.id,
    previous_fund_id: previous?.id ?? null,
    stage_drift: { from: stageBefore, to: stageNow, changed: stageChanged },
    sector_drift_jaccard: sectorJac,
    geo_drift_jaccard: geoJac,
    size_ratio: sizeRatio,
    drift_score: Number(driftScore.toFixed(3)),
    signals,
  };
}
