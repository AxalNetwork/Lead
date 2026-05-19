// Task #5: Secondary-listing FMV approximation.
//
// Secondary marketplaces (Forge Global, EquityZen, Hiive, Augment)
// publish indicative bid/ask prices for late-stage private shares.
// Their pages have a stable shape:
//
//   <h1>Stripe, Inc. (STPE)</h1>
//   ... "Last Trade: $25.10 per share" ...
//   ... "Implied Valuation: $58.4B" ...
//
// We DO NOT crawl these sites paid-API-style — this parser runs on
// HTML the in-house fetcher already retrieved (the crawler's secondary
// listing adapter, future Task #6, enqueues those URLs). Pure
// extraction; no network.

import type { CapTableSnapshotInput } from "./types";
import { parseUsd } from "./normalize";

const VALUATION_RE = /(?:implied\s+valuation|post[\s-]?money|valuation)[^$\n]{0,40}\$?([\d.,]+\s*[KMB]?)/i;
const COMPANY_RE = /<h1[^>]*>\s*([^<]+?)(?:\s*\(([A-Z]{2,6})\))?\s*<\/h1>/i;
const LAST_TRADE_RE = /(?:last\s+trade|indicative\s+price|share\s+price)[^$\n]{0,40}\$([\d.,]+)/i;
const SHARES_RE = /(?:fully[\s-]?diluted|total\s+shares|outstanding)[^\d\n]{0,40}([\d,]+(?:\.\d+)?\s*[KMB]?)/i;
const AS_OF_RE = /(?:as[\s-]?of|updated)[^\d\n]{0,20}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i;

const DATE_MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseAsOf(raw: string | null): string | null {
  if (!raw) return null;
  const m = /(\w+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (!m) return null;
  const month = DATE_MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

export interface SecondaryListingExtractResult {
  ok: boolean;
  reason?: string;
  partial: Partial<CapTableSnapshotInput> & { company_name_raw?: string };
}

export function extractSecondaryListing(html: string, url: string): SecondaryListingExtractResult {
  const company = COMPANY_RE.exec(html);
  if (!company) return { ok: false, reason: "no_company_header", partial: {} };
  const companyName = company[1].trim();
  const valuation = VALUATION_RE.exec(html);
  const sharesRaw = SHARES_RE.exec(html);
  const asOf = parseAsOf(AS_OF_RE.exec(html)?.[1] ?? null) ?? new Date().toISOString().slice(0, 10);
  const lastTrade = LAST_TRADE_RE.exec(html);

  let postMoney: number | null = valuation ? parseUsd(valuation[1]) : null;
  let fdShares: number | null = sharesRaw ? parseUsd(sharesRaw[1]) : null; // parseUsd handles "K/M/B" suffix
  // If we have last-trade price + shares but no valuation, derive it.
  if (!postMoney && lastTrade && fdShares) {
    const price = Number(lastTrade[1].replace(/,/g, ""));
    if (Number.isFinite(price)) postMoney = Math.round(price * fdShares);
  }

  if (!postMoney && !fdShares) return { ok: false, reason: "no_signal_extracted", partial: { company_name_raw: companyName } };
  return {
    ok: true,
    partial: {
      company_name_raw: companyName,
      as_of: asOf,
      source_kind: "secondary_listing",
      source_url: url,
      post_money_usd: postMoney,
      fully_diluted_shares: fdShares,
      notes: lastTrade ? `Indicative last trade: $${lastTrade[1]}/share` : null,
      holders: [],
    },
  };
}
