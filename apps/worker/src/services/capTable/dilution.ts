// Task #5: dilution waterfall math.
//
// Given an ordered set of snapshots for one company (oldest → newest),
// compute per-snapshot share-class deltas and the implied dilution each
// existing holder took. The UI tab renders this as a waterfall chart.
//
// Algorithm (intentionally simple — the spec gates this on snapshot
// confidence ≥ 0.5 so we never present fabricated precision):
//   1. Sort snapshots by as_of ASC.
//   2. For each consecutive pair (A, B), compute the post-money / share-
//      count growth ratio. Each holder appearing in BOTH snapshots gets
//      `pct_change = (pct_B - pct_A)`; new holders in B get pct_change =
//      pct_B with `new_round = true`.
//   3. Aggregate per-class deltas (founder / preferred / option pool).
//
// All numbers are nullable — many private-company sources lack share
// counts (Form D, press releases). When share counts are missing, we
// fall back to pct_ownership-only math. When BOTH are missing for a
// holder, that holder is excluded from the dilution row (the UI will
// show "— dilution unknown for X").

import type { CapTableSourceKind, HolderClass, SecurityType } from "./types";

export interface DilutionHolder {
  holder_name: string;
  holder_entity_id: string | null;
  pct_before: number | null;
  pct_after: number | null;
  pct_change: number | null;
  shares_before: number | null;
  shares_after: number | null;
  new_in_round: boolean;
  exited: boolean;
  round_acquired: string | null;
  holder_class: HolderClass;
  security_type: SecurityType | null;
}

export interface DilutionStep {
  from_snapshot_id: string;
  to_snapshot_id: string;
  from_as_of: string;
  to_as_of: string;
  from_source_kind: CapTableSourceKind;
  to_source_kind: CapTableSourceKind;
  from_post_money_usd: number | null;
  to_post_money_usd: number | null;
  from_fully_diluted_shares: number | null;
  to_fully_diluted_shares: number | null;
  share_growth_ratio: number | null;     // shares_after / shares_before
  founder_pct_change: number | null;
  preferred_pct_change: number | null;
  option_pool_pct_change: number | null;
  holders: DilutionHolder[];
  confidence: number;
}

export interface SnapshotForDilution {
  id: string;
  as_of: string;
  source_kind: CapTableSourceKind;
  fully_diluted_shares: number | null;
  post_money_usd: number | null;
  option_pool_pct: number | null;
  preferred_pct: number | null;
  common_pct: number | null;
  confidence: number;
  holders: Array<{
    holder_name_normalized: string | null;
    holder_name_raw: string;
    holder_entity_id: string | null;
    holder_class: HolderClass;
    security_type: SecurityType | null;
    shares: number | null;
    pct_ownership: number | null;
    round_acquired: string | null;
  }>;
}

/** Stand-alone deal_event (funding_round) merged into the timeline so
 *  the waterfall can interpolate between higher-confidence parsed
 *  snapshots. When a deal has no corresponding cap-table snapshot,
 *  we still know "post-money went from $X to $Y across this round."
 *  These appear as `source_kind = press_inference` synthetic
 *  snapshots in the merged stream. */
export interface DealEventForDilution {
  id: string;
  as_of: string;
  round_name: string | null;
  amount_usd: number | null;
  valuation_usd: number | null;
  sector_tag: string | null;
}

export interface TrajectoryProjection {
  // Best-effort extrapolation: applies the average per-step share
  // growth and per-step founder-dilution across observed steps.
  projected_as_of: string;
  projected_post_money_usd: number | null;
  projected_founder_pct: number | null;
  projected_share_growth_ratio: number | null;
  basis_steps: number;
}

function classPct(snap: SnapshotForDilution, cls: HolderClass): number | null {
  // Prefer the snapshot-level summary fields when present; else aggregate
  // the holder rows.
  if (cls === "preferred_investor" && snap.preferred_pct != null) return snap.preferred_pct;
  if (cls === "founder" && snap.common_pct != null) {
    // No native split between founder commons and other commons in the
    // snapshot summary; fall through to holder aggregation.
  }
  let sum = 0;
  let any = false;
  for (const h of snap.holders) {
    if (h.holder_class !== cls) continue;
    if (h.pct_ownership == null) continue;
    sum += h.pct_ownership;
    any = true;
  }
  return any ? sum : null;
}

function holderKey(h: SnapshotForDilution["holders"][number]): string {
  return h.holder_entity_id ?? (h.holder_name_normalized ?? h.holder_name_raw.toLowerCase());
}

/** Merge deal_events into the snapshot timeline. Each deal that has
 *  no nearby snapshot (±30d) is promoted to a synthetic snapshot so
 *  the waterfall sees the round as a step. Missing post-money is
 *  filled from a sector median when one is provided.
 *
 *  Inputs:
 *    snapshots — real cap-table snapshots
 *    deals     — deal_event rows (funding_round only)
 *    sectorMedianPostMoneyUsd — optional fallback post-money to apply
 *                               when a deal lacks a valuation
 */
export function mergeDealEventsIntoTimeline(
  snapshots: SnapshotForDilution[],
  deals: DealEventForDilution[],
  sectorMedianPostMoneyUsd: number | null = null,
): SnapshotForDilution[] {
  const out: SnapshotForDilution[] = snapshots.slice();
  const snapDates = new Set(snapshots.map((s) => s.as_of.slice(0, 10)));
  for (const d of deals) {
    if (!d.as_of) continue;
    const day = d.as_of.slice(0, 10);
    // Skip if a real snapshot exists within ±30 days.
    let near = false;
    for (const s of snapshots) {
      const dt = Math.abs(Date.parse(s.as_of) - Date.parse(d.as_of));
      if (Number.isFinite(dt) && dt < 30 * 86400_000) { near = true; break; }
    }
    if (near || snapDates.has(day)) continue;
    const post = d.valuation_usd ?? sectorMedianPostMoneyUsd ?? null;
    out.push({
      id: `deal:${d.id}`,
      as_of: d.as_of,
      source_kind: "press_inference",
      fully_diluted_shares: null,
      post_money_usd: post,
      option_pool_pct: null,
      preferred_pct: null,
      common_pct: null,
      confidence: 0.30,
      holders: [],
    });
  }
  return out;
}

/** Project one step forward from the observed dilution trajectory.
 *  Uses the geometric mean of per-step share-growth and the
 *  arithmetic mean of founder pct deltas. Returns null when we have
 *  fewer than 2 steps to extrapolate from. */
export function projectTrajectory(steps: DilutionStep[], horizonMonths: number = 12): TrajectoryProjection | null {
  if (steps.length < 2) return null;
  const ratios = steps.map((s) => s.share_growth_ratio).filter((r): r is number => r != null && r > 0);
  const founderDeltas = steps.map((s) => s.founder_pct_change).filter((r): r is number => r != null);
  const last = steps[steps.length - 1];
  const lastDate = new Date(last.to_as_of + "T00:00:00Z").getTime();
  if (!Number.isFinite(lastDate)) return null;
  const target = new Date(lastDate + horizonMonths * 30 * 86400_000).toISOString().slice(0, 10);
  const geoMeanRatio = ratios.length
    ? Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length)
    : null;
  const meanFounderDelta = founderDeltas.length
    ? founderDeltas.reduce((a, r) => a + r, 0) / founderDeltas.length
    : null;
  const founderLast = steps[steps.length - 1].holders
    .filter((h) => h.holder_class === "founder")
    .reduce((a, h) => a + (h.pct_after ?? 0), 0);
  return {
    projected_as_of: target,
    projected_post_money_usd: last.to_post_money_usd != null && geoMeanRatio != null
      ? Math.round(last.to_post_money_usd * geoMeanRatio) : null,
    projected_founder_pct: meanFounderDelta != null ? Math.max(0, founderLast + meanFounderDelta) : null,
    projected_share_growth_ratio: geoMeanRatio,
    basis_steps: steps.length,
  };
}

/** Build per-snapshot dilution steps from a chronological snapshot list. */
export function buildDilutionWaterfall(snapshots: SnapshotForDilution[]): DilutionStep[] {
  const sorted = snapshots.slice().sort((a, b) => a.as_of.localeCompare(b.as_of));
  const steps: DilutionStep[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const A = sorted[i - 1];
    const B = sorted[i];
    const beforeByKey = new Map<string, SnapshotForDilution["holders"][number]>();
    for (const h of A.holders) beforeByKey.set(holderKey(h), h);
    const seenAfter = new Set<string>();
    const holders: DilutionHolder[] = [];
    for (const h of B.holders) {
      const key = holderKey(h);
      seenAfter.add(key);
      const prev = beforeByKey.get(key) ?? null;
      const pct_before = prev?.pct_ownership ?? null;
      const pct_after = h.pct_ownership ?? null;
      const pct_change = pct_before != null && pct_after != null ? pct_after - pct_before : null;
      holders.push({
        holder_name: h.holder_name_raw,
        holder_entity_id: h.holder_entity_id,
        pct_before, pct_after, pct_change,
        shares_before: prev?.shares ?? null,
        shares_after: h.shares ?? null,
        new_in_round: !prev,
        exited: false,
        round_acquired: h.round_acquired,
        holder_class: h.holder_class,
        security_type: h.security_type,
      });
    }
    // Holders that DROPPED OUT between A and B (rare on cap tables —
    // would mean a buyback / secondary exit / forfeiture).
    for (const [key, prev] of beforeByKey) {
      if (seenAfter.has(key)) continue;
      holders.push({
        holder_name: prev.holder_name_raw,
        holder_entity_id: prev.holder_entity_id,
        pct_before: prev.pct_ownership ?? null,
        pct_after: 0,
        pct_change: prev.pct_ownership != null ? -prev.pct_ownership : null,
        shares_before: prev.shares ?? null,
        shares_after: 0,
        new_in_round: false,
        exited: true,
        round_acquired: prev.round_acquired,
        holder_class: prev.holder_class,
        security_type: prev.security_type,
      });
    }
    const share_growth_ratio =
      A.fully_diluted_shares && B.fully_diluted_shares
        ? B.fully_diluted_shares / A.fully_diluted_shares
        : null;
    const founderA = classPct(A, "founder");
    const founderB = classPct(B, "founder");
    const prefA = classPct(A, "preferred_investor");
    const prefB = classPct(B, "preferred_investor");
    const optA = A.option_pool_pct;
    const optB = B.option_pool_pct;
    steps.push({
      from_snapshot_id: A.id, to_snapshot_id: B.id,
      from_as_of: A.as_of, to_as_of: B.as_of,
      from_source_kind: A.source_kind, to_source_kind: B.source_kind,
      from_post_money_usd: A.post_money_usd, to_post_money_usd: B.post_money_usd,
      from_fully_diluted_shares: A.fully_diluted_shares,
      to_fully_diluted_shares: B.fully_diluted_shares,
      share_growth_ratio,
      founder_pct_change: founderA != null && founderB != null ? founderB - founderA : null,
      preferred_pct_change: prefA != null && prefB != null ? prefB - prefA : null,
      option_pool_pct_change: optA != null && optB != null ? optB - optA : null,
      holders: holders.sort((a, b) =>
        (Math.abs(b.pct_change ?? 0) - Math.abs(a.pct_change ?? 0))),
      confidence: Math.min(A.confidence, B.confidence),
    });
  }
  return steps;
}
