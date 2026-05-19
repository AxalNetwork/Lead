// Task #9: Per-source mark ingestion drivers.
//
// Each driver converts an upstream artifact into a ValuationMarkInput
// and lands it via `persistValuationMark`. The drivers are thin: heavy
// extraction lives in source-specific parsers (nportParser,
// secondaryListingParser from Task #5, etc.).

import type { Env } from "../../types";
import { persistValuationMark } from "./persist";
import type { ValuationMarkPersistResult } from "./types";
import { extractSecondaryListing } from "../capTable/secondaryListingParser";
import { extractNportHoldings, filterPrivateCompanyHoldings } from "./nportParser";

// ------------------------------------------------------------ PRIMARY ROUND
// Replays one row from deal_events as a primary_round mark. Idempotent
// via dedupe_key (deal_id + as_of).
export async function landMarkFromDealEvent(
  env: Env, deal_id: string,
): Promise<ValuationMarkPersistResult> {
  const d = await env.DB.prepare(
    `SELECT id, company_entity_id, company_name_raw, valuation_usd,
            COALESCE(announcement_date, closing_date) AS as_of,
            source_url, round_name, valuation_type
       FROM deal_events
      WHERE id = ? AND event_type = 'funding_round'
        AND valuation_usd IS NOT NULL
        AND COALESCE(announcement_date, closing_date) IS NOT NULL`,
  ).bind(deal_id).first<{
    id: string; company_entity_id: string | null; company_name_raw: string;
    valuation_usd: number; as_of: string; source_url: string | null;
    round_name: string | null; valuation_type: string | null;
  }>();
  if (!d) return { mark_id: null, company_entity_id: null, skipped: true, reason: "deal_not_found_or_no_valuation" };
  return await persistValuationMark(env, {
    company_entity_id: d.company_entity_id,
    company_name_raw: d.company_name_raw,
    as_of: d.as_of.slice(0, 10),
    source_kind: "primary_round",
    source_url: d.source_url,
    source_ref: d.id,
    implied_valuation_usd: d.valuation_usd,
    mark_kind: d.valuation_type === "pre_money" ? "pre_money" : "post_money",
    notes: d.round_name ?? null,
  });
}

/** Sweep every funding round with a valuation for a given company. */
export async function sweepPrimaryRoundMarksForCompany(
  env: Env, entityId: string,
): Promise<ValuationMarkPersistResult[]> {
  const r = await env.DB.prepare(
    `SELECT id FROM deal_events
      WHERE company_entity_id = ? AND event_type = 'funding_round'
        AND valuation_usd IS NOT NULL
        AND COALESCE(announcement_date, closing_date) IS NOT NULL`,
  ).bind(entityId).all<{ id: string }>();
  const out: ValuationMarkPersistResult[] = [];
  for (const row of (r.results ?? []).slice(0, 100)) {
    out.push(await landMarkFromDealEvent(env, row.id));
  }
  return out;
}

// ------------------------------------------------------------ SECONDARY LISTING
// Re-uses the Task #5 secondary-listing parser. Caller provides the
// fetched HTML (we don't refetch).
export async function landMarkFromSecondaryListingHtml(
  env: Env, args: { company_entity_id: string | null; company_name_raw: string; listing_url: string; html: string },
): Promise<ValuationMarkPersistResult> {
  const ex = extractSecondaryListing(args.html, args.listing_url);
  if (!ex.ok) return { mark_id: null, company_entity_id: null, skipped: true, reason: ex.reason ?? "extract_failed" };
  const asOf = ex.partial.as_of ?? new Date().toISOString().slice(0, 10);
  if (ex.partial.post_money_usd == null) {
    return { mark_id: null, company_entity_id: null, skipped: true, reason: "no_valuation_in_listing" };
  }
  return await persistValuationMark(env, {
    company_entity_id: args.company_entity_id,
    company_name_raw: ex.partial.company_name_raw ?? args.company_name_raw,
    as_of: asOf,
    source_kind: "secondary_listing",
    source_url: args.listing_url,
    implied_valuation_usd: ex.partial.post_money_usd,
    fully_diluted_shares: ex.partial.fully_diluted_shares ?? null,
    mark_kind: "mid",
    notes: ex.partial.notes ?? null,
  });
}

// ------------------------------------------------------------ 409A INDICATOR
// Lightweight: takes a strike price + estimated FD share count and
// projects an FMV mark. Caller supplies the indicator (job-posting
// regex, court-filing extractor).
export async function landMarkFrom409A(
  env: Env, args: {
    company_entity_id: string | null; company_name_raw: string;
    as_of: string; strike_price_usd: number; fully_diluted_shares: number;
    source_url: string; notes?: string;
  },
): Promise<ValuationMarkPersistResult> {
  if (args.strike_price_usd <= 0 || args.fully_diluted_shares <= 0) {
    return { mark_id: null, company_entity_id: null, skipped: true, reason: "bad_inputs" };
  }
  const implied = Math.round(args.strike_price_usd * args.fully_diluted_shares);
  return await persistValuationMark(env, {
    company_entity_id: args.company_entity_id,
    company_name_raw: args.company_name_raw,
    as_of: args.as_of,
    source_kind: "four_oh_nine_a",
    source_url: args.source_url,
    implied_valuation_usd: implied,
    share_price_usd: args.strike_price_usd,
    fully_diluted_shares: args.fully_diluted_shares,
    mark_kind: "fmv",
    notes: args.notes ?? null,
  });
}

// ------------------------------------------------------------ MUTUAL FUND N-PORT
// Parse N-PORT XML and land one mark per private-company holding.
export async function landMarksFromNportXml(
  env: Env, args: { xml: string; source_url: string },
): Promise<{ fund_name: string | null; persisted: ValuationMarkPersistResult[]; skipped_count: number }> {
  const parsed = extractNportHoldings(args.xml);
  if (!parsed.ok) return { fund_name: parsed.fund_name, persisted: [], skipped_count: 0 };
  const filtered = filterPrivateCompanyHoldings(parsed.holdings);
  const asOf = (parsed.period_of_report ?? new Date().toISOString()).slice(0, 10);
  const out: ValuationMarkPersistResult[] = [];
  let skipped = 0;
  for (const h of filtered) {
    const r = await persistValuationMark(env, {
      company_entity_id: null,
      company_name_raw: h.issuer_name,
      as_of: asOf,
      source_kind: "mutual_fund_holding",
      source_url: args.source_url,
      source_ref: h.cusip ?? null,
      implied_valuation_usd: h.value_usd != null ? Math.round(h.value_usd) : null,
      mark_kind: "nav",
      holder_name_raw: parsed.fund_name,
      notes: h.pct_of_net_assets != null ? `pct_nav=${h.pct_of_net_assets}` : null,
    });
    if (r.skipped) skipped += 1; else out.push(r);
  }
  return { fund_name: parsed.fund_name, persisted: out, skipped_count: skipped };
}
