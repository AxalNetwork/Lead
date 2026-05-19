// Task #2: Pure helpers for extracting richer exit-signal inputs from
// observed deal-event evidence. Keeping these pure (no DB) lets the
// estimator's IPO and M&A formulas activate without requiring a brand-
// new structured table — the existing `deal_events` columns
// (sources_json, amount_raw, use_of_proceeds, valuation_usd) carry
// the underlying data and we surface what's already there.

/** Sector median revenue multiples used as the M&A fallback when
 *  deal_size is undisclosed. Sourced from public M&A trackers
 *  (Refinitiv / PitchBook category medians as of 2024). Conservative
 *  bias on the low side — we'd rather understate proceeds than puff. */
const SECTOR_MEDIAN_REVENUE_MULTIPLE: Record<string, number> = {
  software: 6,
  saas: 8,
  fintech: 6,
  healthtech: 5,
  biotech: 4,
  consumer: 3,
  marketplace: 5,
  ai: 9,
  climate: 5,
  hardware: 2.5,
  infra: 7,
  cyber: 8,
  default: 4,
};

export function sectorMedianMultiple(tags: string[] | null | undefined): number {
  if (!tags || tags.length === 0) return SECTOR_MEDIAN_REVENUE_MULTIPLE.default;
  for (const t of tags) {
    const k = t.toLowerCase();
    if (SECTOR_MEDIAN_REVENUE_MULTIPLE[k] != null) return SECTOR_MEDIAN_REVENUE_MULTIPLE[k];
  }
  return SECTOR_MEDIAN_REVENUE_MULTIPLE.default;
}

/** Look for an escrow / holdback percentage in the deal's use_of_proceeds
 *  prose. Matches "10% escrow", "$50M holdback (10%)", "indemnity escrow
 *  of 12.5%". Returns null when not present so callers can fall back to 0. */
export function parseEscrowPct(text: string | null | undefined): number | null {
  if (!text) return null;
  const re = /(\d{1,2}(?:\.\d+)?)\s*%\s*(?:escrow|holdback|indemnity)/i;
  const m = re.exec(text);
  if (m) {
    const pct = Number(m[1]) / 100;
    if (pct >= 0 && pct <= 0.5) return pct;
  }
  const re2 = /(?:escrow|holdback|indemnity)[^%]*?(\d{1,2}(?:\.\d+)?)\s*%/i;
  const m2 = re2.exec(text);
  if (m2) {
    const pct = Number(m2[1]) / 100;
    if (pct >= 0 && pct <= 0.5) return pct;
  }
  return null;
}

/** Parse IPO share counts + offer price from deal_events.sources_json or
 *  use_of_proceeds. The aggregator captures these for S-1 / 424B sources
 *  but we only need a small set of regex matches at read time. */
export interface IpoExtras {
  ipo_offer_price_usd: number | null;
  ipo_shares_sold: number | null;
  ipo_retained_shares: number | null;
}

export function parseIpoExtras(
  use_of_proceeds: string | null | undefined,
  amount_raw: string | null | undefined,
  valuation_usd: number | null | undefined,
): IpoExtras {
  const out: IpoExtras = { ipo_offer_price_usd: null, ipo_shares_sold: null, ipo_retained_shares: null };
  const blob = `${use_of_proceeds ?? ""}\n${amount_raw ?? ""}`;
  // "$24 per share" / "offer price of $24" / "priced at $24.00"
  const priceRe = /(?:offer\s+price|priced\s+at|per\s+share[^\d]{0,12}|\$\s*)(\d{1,3}(?:\.\d+)?)\s*(?:per\s+share|\/share)?/i;
  const pm = priceRe.exec(blob);
  if (pm) {
    const p = Number(pm[1]);
    if (p > 0 && p < 5000) out.ipo_offer_price_usd = p;
  }
  // "10,000,000 shares" / "20M shares offered" / "sold 5,000,000 shares"
  const sharesRe = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*[mMbB]?)\s*shares\s*(?:offered|sold)?/i;
  const sm = sharesRe.exec(blob);
  if (sm) {
    const s = sm[1].replace(/,/g, "");
    let n: number;
    if (/[mM]$/.test(s)) n = parseFloat(s) * 1_000_000;
    else if (/[bB]$/.test(s)) n = parseFloat(s) * 1_000_000_000;
    else n = Number(s);
    if (Number.isFinite(n) && n > 0) out.ipo_shares_sold = Math.round(n);
  }
  // If we know offer price + valuation we can back into retained shares.
  if (out.ipo_offer_price_usd && out.ipo_shares_sold && valuation_usd && valuation_usd > 0) {
    const totalShares = valuation_usd / out.ipo_offer_price_usd;
    const retained = totalShares - out.ipo_shares_sold;
    if (retained > 0) out.ipo_retained_shares = Math.round(retained);
  }
  return out;
}

// --- Pure deal-row → ExitSignal mapper --------------------------------------
// Extracted from model.fetchExitSignal so the DB-shaped row → ExitSignal
// transform is unit-testable without spinning up the Workers test build.

export type EventKind = "ipo" | "acquisition" | "merger" | "bankruptcy" | "unexited";

export interface DealRowForExit {
  event_type: string;
  amount_usd: number | null;
  valuation_usd: number | null;
  announcement_date: string | null;
  source_url: string | null;
  amount_raw: string | null;
  use_of_proceeds: string | null;
  sector_tags_json: string | null;
}

export interface ExitSignalShape {
  event_kind: EventKind;
  event_date: string | null;
  source_url?: string | null;
  ipo_offer_price_usd?: number | null;
  ipo_shares_sold?: number | null;
  ipo_retained_shares?: number | null;
  vwap_180d_usd?: number | null;
  ma_deal_size_usd?: number | null;
  ma_escrow_pct?: number | null;
  ma_inferred_revenue_usd?: number | null;
  ma_sector_median_multiple?: number | null;
  last_mark_valuation_usd?: number | null;
}

const EVENT_KIND_FROM_DEAL: Record<string, EventKind> = {
  ipo: "ipo",
  acquisition: "acquisition",
  merger: "merger",
  bankruptcy: "bankruptcy",
};

/** Map a raw deal_events row + an optional pre-fetched inferred-revenue
 *  number (read by the caller from `facts` on the company entity) into
 *  an ExitSignal. Returns null when the event_type isn't a liquidity
 *  event we model. Pure — no DB. */
export function dealRowToExitSignal(
  deal: DealRowForExit,
  inferred_revenue_usd: number | null,
): ExitSignalShape | null {
  const kind = EVENT_KIND_FROM_DEAL[deal.event_type];
  if (!kind) return null;
  if (kind === "bankruptcy") {
    return { event_kind: "bankruptcy", event_date: deal.announcement_date, source_url: deal.source_url };
  }
  if (kind === "ipo") {
    const extras = parseIpoExtras(deal.use_of_proceeds, deal.amount_raw, deal.valuation_usd);
    return {
      event_kind: "ipo",
      event_date: deal.announcement_date,
      ipo_offer_price_usd: extras.ipo_offer_price_usd,
      ipo_shares_sold: extras.ipo_shares_sold,
      ipo_retained_shares: extras.ipo_retained_shares,
      last_mark_valuation_usd: deal.valuation_usd ?? null,
      source_url: deal.source_url,
    };
  }
  // acquisition / merger
  let sector_tags: string[] = [];
  try { sector_tags = JSON.parse(deal.sector_tags_json ?? "[]"); } catch { sector_tags = []; }
  const escrow = parseEscrowPct(deal.use_of_proceeds) ?? 0;
  const dealSize = deal.amount_usd ?? deal.valuation_usd ?? null;
  return {
    event_kind: kind,
    event_date: deal.announcement_date,
    ma_deal_size_usd: dealSize,
    ma_escrow_pct: escrow,
    ma_sector_median_multiple: sectorMedianMultiple(sector_tags),
    ma_inferred_revenue_usd: inferred_revenue_usd,
    source_url: deal.source_url,
  };
}

