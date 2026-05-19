// Task #2: Per-company proceeds estimator.
//
// Classifies the liquidity event for a single portfolio company and
// applies the spec formulas:
//   - IPO        : ownership × (shares_sold × offer_price + retained × VWAP180d)
//                   Falls back to ownership × implied_valuation when share
//                   counts are missing.
//   - M&A / merger / acquisition:
//                  ownership × deal_size × (1 − escrow_pct)
//                  Falls back to sector-median revenue multiple × inferred
//                  revenue when deal_size is undisclosed.
//   - bankruptcy : zero realized; residual_usd=0.
//   - unexited   : last valuation_mark × ownership; realized=0.
//
// Pure module: no DB access — accepts pre-fetched signals so it can be
// unit-tested in isolation.

import type { EventKind, ProceedsEstimate } from "./types";

export interface ExitSignal {
  // What we know about the company's liquidity event.
  event_kind: EventKind;
  event_date: string | null;
  // IPO inputs.
  ipo_offer_price_usd?: number | null;
  ipo_shares_sold?: number | null;
  ipo_retained_shares?: number | null;
  vwap_180d_usd?: number | null;
  // M&A inputs.
  ma_deal_size_usd?: number | null;
  ma_escrow_pct?: number | null;                  // 0..1
  ma_inferred_revenue_usd?: number | null;
  ma_sector_median_multiple?: number | null;
  // Generic fallback: valuation mark for unexited or when above missing.
  last_mark_valuation_usd?: number | null;
  source_url?: string | null;
}

export interface CompanyInputs {
  company_entity_id: string | null;
  company_name: string;
  position_usd: number | null;
  ownership_pct: number | null;                   // 0..1
  exit: ExitSignal | null;                        // null = unknown / unexited
}

const CLAMP_OWNERSHIP_MIN = 0.001;
const CLAMP_OWNERSHIP_MAX = 0.5;

/** Best-effort ownership estimate when the round amount + post-money
 *  valuation are known. Otherwise null — caller falls back to a
 *  default 5% assumption with a warning. */
export function estimateOwnership(
  position_usd: number | null,
  post_money_valuation_usd: number | null,
): number | null {
  if (position_usd == null || position_usd <= 0) return null;
  if (post_money_valuation_usd == null || post_money_valuation_usd <= 0) return null;
  const raw = position_usd / post_money_valuation_usd;
  if (!Number.isFinite(raw)) return null;
  return Math.max(CLAMP_OWNERSHIP_MIN, Math.min(CLAMP_OWNERSHIP_MAX, raw));
}

export function estimateProceeds(c: CompanyInputs): ProceedsEstimate {
  const notes: string[] = [];
  const ownership = c.ownership_pct ?? (() => {
    notes.push("ownership_defaulted_to_5pct");
    return 0.05;
  })();
  // No exit signal → unexited path with last mark or written-up at cost.
  if (!c.exit) {
    const mark = c.position_usd ?? 0;
    return {
      company_entity_id: c.company_entity_id,
      company_name: c.company_name,
      position_usd: c.position_usd,
      ownership_pct: ownership,
      event_kind: "unexited",
      event_date: null,
      realized_usd: 0,
      residual_usd: mark,                         // held at cost as last-known fallback
      confidence: 0.2,
      source_url: null,
      notes: notes.length ? [...notes, "no_exit_signal_held_at_cost"] : ["no_exit_signal_held_at_cost"],
    };
  }
  const e = c.exit;
  if (e.event_kind === "bankruptcy") {
    return {
      company_entity_id: c.company_entity_id,
      company_name: c.company_name,
      position_usd: c.position_usd,
      ownership_pct: ownership,
      event_kind: "bankruptcy",
      event_date: e.event_date,
      realized_usd: 0,
      residual_usd: 0,
      confidence: 0.85,
      source_url: e.source_url ?? null,
      notes,
    };
  }
  if (e.event_kind === "ipo") {
    let realized: number | null = null;
    if (e.ipo_offer_price_usd != null && e.ipo_shares_sold != null) {
      const sold = e.ipo_shares_sold * e.ipo_offer_price_usd;
      const retained = (e.ipo_retained_shares ?? 0) * (e.vwap_180d_usd ?? e.ipo_offer_price_usd);
      realized = ownership * (sold + retained);
    } else if (e.last_mark_valuation_usd != null) {
      realized = ownership * e.last_mark_valuation_usd;
      notes.push("ipo_used_valuation_fallback");
    }
    if (realized == null) {
      notes.push("ipo_missing_inputs");
      return {
        company_entity_id: c.company_entity_id,
        company_name: c.company_name,
        position_usd: c.position_usd,
        ownership_pct: ownership,
        event_kind: "ipo",
        event_date: e.event_date,
        realized_usd: 0,
        residual_usd: c.position_usd ?? 0,
        confidence: 0.3,
        source_url: e.source_url ?? null,
        notes,
      };
    }
    return {
      company_entity_id: c.company_entity_id,
      company_name: c.company_name,
      position_usd: c.position_usd,
      ownership_pct: ownership,
      event_kind: "ipo",
      event_date: e.event_date,
      realized_usd: realized,
      residual_usd: 0,
      confidence: 0.85,
      source_url: e.source_url ?? null,
      notes,
    };
  }
  // M&A / merger / acquisition path.
  if (e.event_kind === "acquisition" || e.event_kind === "merger") {
    const escrow = Math.max(0, Math.min(0.5, e.ma_escrow_pct ?? 0));
    let dealSize = e.ma_deal_size_usd ?? null;
    if (dealSize == null && e.ma_inferred_revenue_usd != null && e.ma_sector_median_multiple != null) {
      dealSize = e.ma_inferred_revenue_usd * e.ma_sector_median_multiple;
      notes.push("ma_used_sector_median_multiple");
    }
    if (dealSize == null) {
      notes.push("ma_undisclosed_deal_size");
      return {
        company_entity_id: c.company_entity_id,
        company_name: c.company_name,
        position_usd: c.position_usd,
        ownership_pct: ownership,
        event_kind: e.event_kind,
        event_date: e.event_date,
        realized_usd: 0,
        residual_usd: c.position_usd ?? 0,
        confidence: 0.25,
        source_url: e.source_url ?? null,
        notes,
      };
    }
    const realized = ownership * dealSize * (1 - escrow);
    return {
      company_entity_id: c.company_entity_id,
      company_name: c.company_name,
      position_usd: c.position_usd,
      ownership_pct: ownership,
      event_kind: e.event_kind,
      event_date: e.event_date,
      realized_usd: realized,
      residual_usd: 0,
      confidence: e.ma_deal_size_usd != null ? 0.85 : 0.55,
      source_url: e.source_url ?? null,
      notes,
    };
  }
  // unexited with explicit last mark.
  const residual = (e.last_mark_valuation_usd ?? 0) * ownership;
  return {
    company_entity_id: c.company_entity_id,
    company_name: c.company_name,
    position_usd: c.position_usd,
    ownership_pct: ownership,
    event_kind: "unexited",
    event_date: e.event_date,
    realized_usd: 0,
    residual_usd: residual > 0 ? residual : (c.position_usd ?? 0),
    confidence: residual > 0 ? 0.5 : 0.25,
    source_url: e.source_url ?? null,
    notes,
  };
}

/** Confidence band per the spec:
 *    ≥70% positions resolved → high
 *    40–70% → medium
 *    <40%   → low
 *  An "unexited" position is NOT resolved; only ipo / acquisition /
 *  merger / bankruptcy count toward resolved coverage. */
export function scoreConfidence(positions_total: number, positions_resolved: number): "high" | "medium" | "low" {
  if (positions_total <= 0) return "low";
  const pct = positions_resolved / positions_total;
  if (pct >= 0.7) return "high";
  if (pct >= 0.4) return "medium";
  return "low";
}

/** Fee drag: 2% per year × years since first close × committed.
 *  Caps at 10 years (typical fund life). Returns 0 when committed or
 *  first_close_date is missing — caller logs a warning. */
export function computeFeeDrag(
  committed_usd: number | null,
  first_close_date: string | null,
  as_of: string,
  pct_per_year: number = 0.02,
): number {
  if (committed_usd == null || committed_usd <= 0 || !first_close_date) return 0;
  const t0 = new Date(first_close_date);
  const t1 = new Date(as_of);
  if (Number.isNaN(t0.getTime()) || Number.isNaN(t1.getTime())) return 0;
  const ms = t1.getTime() - t0.getTime();
  const years = Math.max(0, Math.min(10, ms / (365.25 * 24 * 3600 * 1000)));
  return committed_usd * pct_per_year * years;
}
