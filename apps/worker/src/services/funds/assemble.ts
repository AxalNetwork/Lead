// Task #3: Fund assembler.
//
// Builds or refreshes a `funds` row by combining every available signal
// for a (firm, fund-name) pair:
//   1. Form ADV Item 7 — sec_form_adv_funds (managed funds, GAV)
//   2. Form D filings   — sec_form_d_rounds keyed on issuer name
//   3. LP disclosures   — lp_fund_commitments (vintage, committed)
//   4. Deal flow press  — deal_events.amount_usd citing the fund name
//   5. firm fact graph  — existing fund-name facts already observed
//
// Per-field canonical pick uses the same source-authority hierarchy as
// the deal aggregator (SEC > company blog > press release > tech press,
// with LP disclosures + firm sites slotted in). Every contributing
// signal is recorded in source_evidence_json so downstream consumers
// can render the citation trail without a secondary join.
//
// All firm-level entity facts (firm.latest_fund_vintage,
// firm.latest_fund_size_usd, strategy_drift) flow through `insertFact`
// — this file never writes into `facts` directly.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { resolveFundName, normalizeFundName } from "../fundResolver";
import {
  FUND_AUTHORITY, type FundEvidence, type FundRow,
  type FundSourceType, type FundStatus, type FundStrategy,
} from "./types";

export interface AssembleResult {
  fund_id: string | null;
  firm_entity_id: string;
  fund_name: string;
  created: boolean;
  evidence_count: number;
  status: FundStatus;
}

interface FieldPick<T> {
  value: T | null;
  source_type: FundSourceType | null;
  source_url: string | null;
  observed_at: string | null;
}

function pickByAuthority<T>(
  existing: FieldPick<T>,
  incoming: { value: T | null | undefined; source_type: FundSourceType; source_url: string | null; observed_at: string },
  evidence: FundEvidence[],
  field: string,
): FieldPick<T> {
  if (incoming.value == null) return existing;
  evidence.push({
    field, value: incoming.value as unknown,
    source_type: incoming.source_type,
    source_url: incoming.source_url,
    observed_at: incoming.observed_at,
  });
  if (existing.value == null) {
    return { value: incoming.value, source_type: incoming.source_type, source_url: incoming.source_url, observed_at: incoming.observed_at };
  }
  const existingAuth = existing.source_type ? FUND_AUTHORITY[existing.source_type] : 0;
  const incomingAuth = FUND_AUTHORITY[incoming.source_type];
  if (incomingAuth > existingAuth) {
    return { value: incoming.value, source_type: incoming.source_type, source_url: incoming.source_url, observed_at: incoming.observed_at };
  }
  return existing;
}

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13,
};

/** Extract fund_number from a fund name like "Foo Capital Fund IV" or
 *  "Foo Capital Fund 4". Returns null when no roman/arabic suffix. */
export function extractFundNumber(name: string): number | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  // Trailing arabic
  let m = /\b(\d{1,2})\b\s*(?:,\s*l\.?p\.?|llc|fund)?\s*$/i.exec(lower);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 30) return n;
  }
  // Trailing roman (after optional "fund")
  m = /\b(xiii|xii|xi|viii|vii|vi|iv|iii|ii|ix|x|v|i)\b\s*(?:,\s*l\.?p\.?|llc)?\s*$/i.exec(lower);
  if (m) return ROMAN[m[1]] ?? null;
  return null;
}

/** Heuristic strategy classification from fund-name keywords. The
 *  assembler always prefers explicit facts (e.g. ADV fund_type) over
 *  this name-based guess. */
export function strategyFromName(name: string): FundStrategy | null {
  const n = name.toLowerCase();
  if (/\bseed\b/.test(n)) return "seed";
  if (/\bearly[- ]stage\b/.test(n)) return "early";
  if (/\bgrowth\s+equity\b/.test(n)) return "growth_equity";
  if (/\bgrowth\b/.test(n)) return "growth";
  if (/\blate[- ]stage\b/.test(n)) return "late";
  if (/\bbuyout\b/.test(n)) return "buyout";
  if (/\bsecondar(y|ies)\b/.test(n)) return "secondary";
  if (/\bfund\s+of\s+funds\b|\bfof\b/.test(n)) return "fund_of_funds";
  if (/\bcredit\b|\bdebt\b|\bdirect lending\b/.test(n)) return "credit";
  return null;
}

function strategyFromAdvType(advType: string | null | undefined): FundStrategy | null {
  if (!advType) return null;
  const t = advType.toLowerCase().replace(/[_\s]+/g, "_");
  if (t.includes("venture")) return "early";
  if (t.includes("private_equity")) return "buyout";
  if (t.includes("hedge")) return null;
  if (t.includes("real_estate")) return null;
  return null;
}

interface AdvFundRow {
  fund_name: string;
  fund_id_807: string | null;
  fund_type: string | null;
  gross_asset_value: number | null;
  adviser_entity_id: string | null;
  filed_at: string | null;
  accession_no: string;
}

interface FormDRow {
  issuer_name: string;
  total_amount_sold: number | null;
  total_offering_amount: number | null;
  date_of_first_sale: string | null;
  industry_group: string | null;
  filing_url: string | null;
  filed_at: string | null;
}

interface DealEventRow {
  id: string;
  amount_usd: number | null;
  announcement_date: string | null;
  round_name: string | null;
  source_url: string | null;
  source_type: string | null;
}

interface LpCommitRow {
  vintage_year: number | null;
  committed_usd: number | null;
  as_of_date: string;
  source_url: string | null;
}

interface FundPressRow {
  id: string;
  url: string;
  host: string;
  title: string | null;
  headline: string | null;
  summary: string | null;
  body_excerpt: string | null;
  published_at: string | null;
  source_reputability: number;
}

/** Load every signal for one firm's fund name. Bounded queries — each
 *  capped at 100 rows; assembly is per-fund, not per-firm. */
async function loadSignals(
  env: Env, firmEntityId: string, fundName: string, fundEntityId: string | null,
): Promise<{
  adv: AdvFundRow[]; form_d: FormDRow[]; deals: DealEventRow[]; lp: LpCommitRow[];
  press: FundPressRow[];
}> {
  const normalized = normalizeFundName(fundName);
  const advRes = await env.DB.prepare(
    `SELECT f.fund_name, f.fund_id_807, f.fund_type, f.gross_asset_value,
            f.adviser_entity_id, fl.filed_at, f.accession_no
       FROM sec_form_adv_funds f
       LEFT JOIN sec_filings fl ON fl.accession_no = f.accession_no
      WHERE f.adviser_entity_id = ? AND lower(f.fund_name) = ?
      ORDER BY fl.filed_at DESC NULLS LAST
      LIMIT 25`,
  ).bind(firmEntityId, fundName.toLowerCase()).all<AdvFundRow>();
  const adv = advRes.results ?? [];

  // Form D rows whose issuer_name normalizes to the same key AND the
  // adviser/firm is named as a related person on the filing (so a
  // similarly-named fund from a different firm cannot contaminate the
  // signal). Firm scoping uses the firm entity's display_name.
  const firmRow = await env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(firmEntityId).first<{ display_name: string | null }>();
  const firmName = (firmRow?.display_name ?? "").trim().toLowerCase();
  const formDRes = firmName
    ? await env.DB.prepare(
        `SELECT r.issuer_name, r.total_amount_sold, r.total_offering_amount,
                r.date_of_first_sale, r.industry_group,
                fl.filing_url, fl.filed_at
           FROM sec_form_d_rounds r
           LEFT JOIN sec_filings fl ON fl.accession_no = r.accession_no
          WHERE lower(r.issuer_name) LIKE ?
            AND (r.entity_id = ? OR lower(r.related_persons_json) LIKE ?)
          ORDER BY r.date_of_first_sale DESC NULLS LAST
          LIMIT 50`,
      ).bind(`%${fundName.toLowerCase().slice(0, 60)}%`, firmEntityId, `%${firmName}%`)
       .all<FormDRow>()
    : { results: [] as FormDRow[] };
  const form_d = (formDRes.results ?? []).filter((r) => {
    return normalizeFundName(r.issuer_name).includes(normalized) ||
           normalized.includes(normalizeFundName(r.issuer_name));
  });

  // Deal events naming the firm as participant — used for deployed-capital
  // estimate. Narrowed by firm participation, not fund name (the press
  // release rarely names the fund).
  const dealsRes = await env.DB.prepare(
    `SELECT d.id, d.amount_usd, d.announcement_date, d.round_name,
            d.source_url, d.source_type
       FROM deal_events d
       JOIN deal_participants p ON p.deal_id = d.id
      WHERE p.investor_entity_id = ?
      ORDER BY d.announcement_date DESC NULLS LAST
      LIMIT 500`,
  ).bind(firmEntityId).all<DealEventRow>();
  const deals = dealsRes.results ?? [];

  // LP disclosures naming this fund (by entity id when resolved).
  let lp: LpCommitRow[] = [];
  if (fundEntityId) {
    const lpRes = await env.DB.prepare(
      `SELECT vintage_year, committed_usd, as_of_date, source_url
         FROM lp_fund_commitments
        WHERE fund_entity_id = ?
        ORDER BY as_of_date DESC
        LIMIT 100`,
    ).bind(fundEntityId).all<LpCommitRow>();
    lp = lpRes.results ?? [];
  }

  // Fund-specific press: news_items mentioning this firm (via
  // news_entity_mentions) whose title / headline / summary / excerpt
  // contains the fund name. This is the dedicated press/blog/fund-page
  // signal channel — distinct from generic firm deal-flow press.
  const fundNameL = fundName.toLowerCase();
  const press: FundPressRow[] = [];
  if (fundNameL.length >= 4) {
    const pressRes = await env.DB.prepare(
      `SELECT n.id, n.url, n.host, n.title, n.headline, n.summary,
              n.body_excerpt, n.published_at, n.source_reputability
         FROM news_items n
         JOIN news_entity_mentions m ON m.news_item_id = n.id
        WHERE m.entity_id = ?
          AND (lower(COALESCE(n.title, '')) LIKE ?
               OR lower(COALESCE(n.headline, '')) LIKE ?
               OR lower(COALESCE(n.summary, '')) LIKE ?
               OR lower(COALESCE(n.body_excerpt, '')) LIKE ?)
        ORDER BY n.published_at DESC NULLS LAST
        LIMIT 50`,
    ).bind(
      firmEntityId,
      `%${fundNameL}%`, `%${fundNameL}%`, `%${fundNameL}%`, `%${fundNameL}%`,
    ).all<FundPressRow>();
    press.push(...(pressRes.results ?? []));
  }

  return { adv, form_d, deals, lp, press };
}

/** Source-type classification for a press host. Tech press sites get a
 *  lower authority than blogs/PR; firm sites get the firm_site bucket. */
function pressSourceType(host: string, firmName: string): FundSourceType {
  const h = host.toLowerCase();
  if (firmName && h.includes(firmName.toLowerCase().split(/\s+/)[0])) return "firm_site";
  if (h.includes("prnewswire") || h.includes("businesswire") || h.includes("globenewswire")) return "press_release";
  if (h.includes("techcrunch") || h.includes("axios") || h.includes("bloomberg") ||
      h.includes("ft.com") || h.includes("wsj.com") || h.includes("reuters")) return "tech_press";
  return "company_blog";
}

const MONTHS: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
};

/** Extract a final-close ISO date from press text. Looks for phrases
 *  like "closed Fund III at $500M on March 15, 2024" or "final close
 *  of $1.2B". Returns null when nothing parseable. */
export function extractFinalCloseDate(text: string, publishedAt: string | null): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (!/\b(final close|closed (its|the)|closes? .{0,30}fund)\b/.test(t)) return null;
  // Try "Month DD, YYYY"
  const m1 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\.?\s+(\d{1,2}),\s*(\d{4})\b/i.exec(text);
  if (m1) {
    const mo = MONTHS[m1[1].toLowerCase()];
    if (mo) return `${m1[3]}-${String(mo).padStart(2,"0")}-${String(Number(m1[2])).padStart(2,"0")}`;
  }
  // Fall back to publish date (best signal when the article ANNOUNCES the close)
  return publishedAt ? publishedAt.slice(0, 10) : null;
}

/** Extract a USD amount from press text. Returns whole USD or null. */
export function extractUsdAmount(text: string): number | null {
  if (!text) return null;
  // Matches "$1.2 billion", "$500 million", "$500m", "$1.2bn"
  const m = /\$\s*(\d+(?:\.\d+)?)\s*(billion|bn|b|million|mn|m)\b/i.exec(text);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith("b") ? 1_000_000_000 : 1_000_000;
  return Math.round(num * mult);
}

/** Extract a 4-digit vintage year from press text. */
export function extractVintageYear(text: string): number | null {
  if (!text) return null;
  const m = /\b(?:vintage|inception)\s*(?:of\s*)?(\d{4})\b/i.exec(text);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1980 && y <= 2100) return y;
  }
  return null;
}

export interface AssembleInput {
  firm_entity_id: string;
  fund_name: string;
  source: string;
}

/**
 * Assemble (or refresh) one funds row. Idempotent on
 * (firm_entity_id, fund_name).
 */
export async function assembleFund(env: Env, input: AssembleInput): Promise<AssembleResult> {
  const firmEntityId = input.firm_entity_id;
  const fundName = (input.fund_name ?? "").trim();
  if (!firmEntityId || !fundName) {
    return { fund_id: null, firm_entity_id: firmEntityId, fund_name: fundName, created: false, evidence_count: 0, status: "active" };
  }
  const source = input.source || "fund_assembler";
  const now = new Date().toISOString();

  // Resolve fund entity (and capture gp firm hint).
  const resolved = await resolveFundName(env, {
    raw: fundName,
    gp_firm_hint: null,
    source,
    evidence_url: null,
  });
  const fundEntityId = resolved.fund_entity_id;

  const signals = await loadSignals(env, firmEntityId, fundName, fundEntityId);
  const evidence: FundEvidence[] = [];

  // ---- Per-field arbitration ------------------------------------------
  let vintage:    FieldPick<number>       = { value: null, source_type: null, source_url: null, observed_at: null };
  let target:     FieldPick<number>       = { value: null, source_type: null, source_url: null, observed_at: null };
  let raised:     FieldPick<number>       = { value: null, source_type: null, source_url: null, observed_at: null };
  let firstClose: FieldPick<string>       = { value: null, source_type: null, source_url: null, observed_at: null };
  let finalClose: FieldPick<string>       = { value: null, source_type: null, source_url: null, observed_at: null };
  let strategy:   FieldPick<FundStrategy> = { value: null, source_type: null, source_url: null, observed_at: null };

  // 1. ADV — highest authority for GAV (used as a raised proxy when no
  //    LP/Form D commit is available) and for strategy via fund_type.
  for (const a of signals.adv) {
    raised = pickByAuthority(raised, {
      value: a.gross_asset_value, source_type: "sec_filing",
      source_url: a.accession_no ? `sec://${a.accession_no}` : null,
      observed_at: a.filed_at ?? now,
    }, evidence, "announced_raised_usd");
    const s = strategyFromAdvType(a.fund_type);
    if (s) {
      strategy = pickByAuthority(strategy, {
        value: s, source_type: "sec_filing",
        source_url: a.accession_no ? `sec://${a.accession_no}` : null,
        observed_at: a.filed_at ?? now,
      }, evidence, "strategy");
    }
  }

  // 2. Form D — high authority for first-sale date + amount sold.
  let formDAmountSold = 0;
  for (const f of signals.form_d) {
    if (f.date_of_first_sale) {
      firstClose = pickByAuthority(firstClose, {
        value: f.date_of_first_sale, source_type: "sec_filing",
        source_url: f.filing_url, observed_at: f.filed_at ?? now,
      }, evidence, "first_close_date");
      // Vintage proxy: year of first sale.
      const yr = Number(f.date_of_first_sale.slice(0, 4));
      if (yr >= 1900 && yr <= 2100) {
        vintage = pickByAuthority(vintage, {
          value: yr, source_type: "sec_filing",
          source_url: f.filing_url, observed_at: f.filed_at ?? now,
        }, evidence, "vintage_year");
      }
    }
    if (f.total_offering_amount) {
      target = pickByAuthority(target, {
        value: f.total_offering_amount, source_type: "sec_filing",
        source_url: f.filing_url, observed_at: f.filed_at ?? now,
      }, evidence, "target_size_usd");
    }
    if (f.total_amount_sold) {
      formDAmountSold += f.total_amount_sold;
    }
  }
  if (formDAmountSold > 0) {
    raised = pickByAuthority(raised, {
      value: formDAmountSold, source_type: "sec_filing",
      source_url: signals.form_d[0]?.filing_url ?? null,
      observed_at: signals.form_d[0]?.filed_at ?? now,
    }, evidence, "announced_raised_usd");
  }

  // 3. LP disclosures — corroboration for vintage + committed sum.
  let lpCommitSum = 0;
  for (const l of signals.lp) {
    if (l.vintage_year) {
      vintage = pickByAuthority(vintage, {
        value: l.vintage_year, source_type: "lp_disclosure",
        source_url: l.source_url, observed_at: l.as_of_date,
      }, evidence, "vintage_year");
    }
    if (l.committed_usd) lpCommitSum += l.committed_usd;
  }
  if (lpCommitSum > 0) {
    raised = pickByAuthority(raised, {
      value: lpCommitSum, source_type: "lp_disclosure",
      source_url: signals.lp[0]?.source_url ?? null,
      observed_at: signals.lp[0]?.as_of_date ?? now,
    }, evidence, "announced_raised_usd");
  }

  // 4. Fund-specific press / blog / firm-page (news_items mentioning
  //    the firm whose text contains the fund name). These contribute
  //    canonically to final_close_date, vintage_year, and
  //    announced_raised_usd at their declared authority tier (firm_site
  //    > press_release > tech_press > company_blog).
  const firmDisplay = (await env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(firmEntityId).first<{ display_name: string | null }>())?.display_name ?? "";
  for (const p of signals.press) {
    const text = `${p.title ?? ""}\n${p.headline ?? ""}\n${p.summary ?? ""}\n${p.body_excerpt ?? ""}`;
    const stype = pressSourceType(p.host, firmDisplay);
    const observedAt = p.published_at ?? now;
    // final_close_date
    const fc = extractFinalCloseDate(text, p.published_at);
    if (fc) {
      finalClose = pickByAuthority(finalClose, {
        value: fc, source_type: stype, source_url: p.url, observed_at: observedAt,
      }, evidence, "final_close_date");
    }
    // announced_raised_usd (from "$X billion" mentions in close articles)
    if (/\b(final close|closed|closes)\b/i.test(text)) {
      const amt = extractUsdAmount(text);
      if (amt && amt >= 5_000_000) {
        raised = pickByAuthority(raised, {
          value: amt, source_type: stype, source_url: p.url, observed_at: observedAt,
        }, evidence, "announced_raised_usd");
      }
    }
    // vintage_year
    const vy = extractVintageYear(text) ?? (p.published_at ? Number(p.published_at.slice(0, 4)) : null);
    if (vy && vy >= 1980 && vy <= 2100 && /\b(launches?|launched|raises?|raised|closed|final close)\b/i.test(text)) {
      vintage = pickByAuthority(vintage, {
        value: vy, source_type: stype, source_url: p.url, observed_at: observedAt,
      }, evidence, "vintage_year");
    }
  }

  // 4b. Deal-flow press — corroborating evidence (logged for citation
  //     trail only; does not arbitrate fund-level fields).
  for (const d of signals.deals.slice(0, 25)) {
    if (!d.amount_usd || !d.announcement_date) continue;
    const st = (d.source_type === "sec_filing" || d.source_type === "company_blog" ||
                d.source_type === "press_release" || d.source_type === "tech_press")
      ? d.source_type as FundSourceType : "press_release";
    evidence.push({
      field: "portfolio_deal", value: { deal_id: d.id, amount_usd: d.amount_usd, round_name: d.round_name },
      source_type: st, source_url: d.source_url, observed_at: d.announcement_date,
    });
  }

  // 5. Name-derived fallbacks (lowest authority).
  const nameStrategy = strategyFromName(fundName);
  if (nameStrategy) {
    strategy = pickByAuthority(strategy, {
      value: nameStrategy, source_type: "firm_site",
      source_url: null, observed_at: now,
    }, evidence, "strategy");
  }
  const fundNumber = extractFundNumber(fundName);

  // ---- fund_status derivation ----------------------------------------
  // raising: most-recent Form D within 24 months AND no final-close
  // date observed. active: has Form D / LP data within 5y. harvesting:
  // last evidence 5–10y ago. wound_down: > 10y since last evidence.
  // Press-release corroboration for "raising" status: a fund-NAME-
  // matched press article (from signals.press, which already filters
  // news_items to those mentioning the firm AND containing the fund
  // name) within 18 months of the most-recent Form D, whose text
  // signals an active fundraise (raise/launch/closes-on/target). Form
  // D alone is insufficient per spec; a generic firm deal press is
  // also insufficient — must mention this specific fund.
  const latestFormD = signals.form_d[0]?.date_of_first_sale ?? signals.form_d[0]?.filed_at ?? null;
  const pressRecent = signals.press.some((p) => {
    if (!p.published_at || !latestFormD) return false;
    const txt = `${p.title ?? ""}\n${p.headline ?? ""}\n${p.summary ?? ""}\n${p.body_excerpt ?? ""}`.toLowerCase();
    const isFundraiseSignal = /\b(raises?|raising|launch(es|ed)?|target(ing|ed)?|first close|interim close|seeking commitments?|new fund)\b/.test(txt);
    if (!isFundraiseSignal) return false;
    const a = new Date(p.published_at).getTime();
    const b = new Date(latestFormD).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= 1000 * 60 * 60 * 24 * 30 * 18;
  });
  const status = deriveFundStatus({
    firstClose: firstClose.value,
    finalClose: finalClose.value,
    latestFormD,
    latestLp: signals.lp[0]?.as_of_date ?? null,
    pressCorroboration: pressRecent,
  });

  // ---- sectors / geos from observed deal flow + Form D industry ------
  // Aggregated from this firm's recent investments + Form D issuer
  // industry tags. Bounded to the most-frequent 8 sectors / 5 geos so
  // a single anomaly can't pollute the declared mix.
  const sectorCounts: Record<string, number> = {};
  const geoCounts: Record<string, number> = {};
  for (const f of signals.form_d) {
    if (f.industry_group) sectorCounts[f.industry_group] = (sectorCounts[f.industry_group] ?? 0) + 1;
  }
  for (const d of signals.deals) {
    // deal sector tags aren't loaded in the slim DealEventRow above;
    // skip — sectors_json from Form D industry is enough for the
    // declared mix. Geo comes from a later enrichment pass.
    void d;
  }
  // Also pull sector/geo tags from this firm's most recent deal_events
  // (bounded query — read sector_tags_json + geography directly).
  const tagsRes = await env.DB.prepare(
    `SELECT d.sector_tags_json, d.geography
       FROM deal_events d
       JOIN deal_participants p ON p.deal_id = d.id
      WHERE p.investor_entity_id = ?
      ORDER BY COALESCE(d.announcement_date, d.closing_date) DESC
      LIMIT 200`,
  ).bind(firmEntityId).all<{ sector_tags_json: string | null; geography: string | null }>();
  for (const r of tagsRes.results ?? []) {
    if (r.sector_tags_json) {
      try {
        const arr = JSON.parse(r.sector_tags_json) as string[];
        for (const s of arr) sectorCounts[s] = (sectorCounts[s] ?? 0) + 1;
      } catch { /* ignore */ }
    }
    if (r.geography) geoCounts[r.geography] = (geoCounts[r.geography] ?? 0) + 1;
  }
  const topSectors = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const topGeos    = Object.entries(geoCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const sectorsJson = topSectors.length > 0 ? JSON.stringify(topSectors) : null;
  const geosJson    = topGeos.length > 0    ? JSON.stringify(topGeos)    : null;
  if (sectorsJson) evidence.push({ field: "sectors_json", value: topSectors, source_type: "sec_filing", source_url: null, observed_at: now });
  if (geosJson)    evidence.push({ field: "geos_json",    value: topGeos,    source_type: "press_release", source_url: null, observed_at: now });

  // ---- Persist --------------------------------------------------------
  const id = crypto.randomUUID();
  const evidenceJson = JSON.stringify(evidence.slice(-100));
  const confidence = Math.min(
    0.99,
    0.3 + 0.1 * (signals.adv.length > 0 ? 1 : 0) + 0.1 * (signals.form_d.length > 0 ? 1 : 0) +
    0.1 * (signals.lp.length > 0 ? 1 : 0) + 0.05 * Math.min(6, evidence.length),
  );

  await env.DB.prepare(
    `INSERT INTO funds (
       id, firm_entity_id, fund_entity_id, fund_name, fund_number,
       vintage_year, target_size_usd, hard_cap_usd,
       first_close_date, final_close_date,
       announced_raised_usd, gp_commit_usd,
       mgmt_fee_pct, carry_pct, hurdle_pct,
       strategy, sectors_json, geos_json, fund_status,
       source_evidence_json, confidence, updated_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(firm_entity_id, fund_name) DO UPDATE SET
       fund_entity_id       = COALESCE(excluded.fund_entity_id, funds.fund_entity_id),
       fund_number          = COALESCE(excluded.fund_number, funds.fund_number),
       vintage_year         = COALESCE(excluded.vintage_year, funds.vintage_year),
       target_size_usd      = COALESCE(excluded.target_size_usd, funds.target_size_usd),
       first_close_date     = COALESCE(excluded.first_close_date, funds.first_close_date),
       final_close_date     = COALESCE(excluded.final_close_date, funds.final_close_date),
       announced_raised_usd = COALESCE(excluded.announced_raised_usd, funds.announced_raised_usd),
       strategy             = COALESCE(excluded.strategy, funds.strategy),
       sectors_json         = COALESCE(excluded.sectors_json, funds.sectors_json),
       geos_json            = COALESCE(excluded.geos_json, funds.geos_json),
       fund_status          = excluded.fund_status,
       source_evidence_json = excluded.source_evidence_json,
       confidence           = MAX(excluded.confidence, funds.confidence),
       updated_at           = excluded.updated_at`,
  ).bind(
    id, firmEntityId, fundEntityId, fundName, fundNumber,
    vintage.value, target.value,
    firstClose.value, finalClose.value,
    raised.value,
    strategy.value,
    sectorsJson, geosJson,
    status,
    evidenceJson, confidence, now, now,
  ).run();

  const row = await env.DB.prepare(
    `SELECT id FROM funds WHERE firm_entity_id = ? AND fund_name = ?`,
  ).bind(firmEntityId, fundName).first<{ id: string }>();
  const fundId = row?.id ?? id;
  const wasNew = fundId === id;

  // ---- Mirror entity-level facts via canonical write path -------------
  if (vintage.value != null) {
    await insertFact(env, {
      entity_id: firmEntityId, predicate: "firm.latest_fund_vintage",
      source_kind: "scrape", source,
      value_number: vintage.value, confidence,
      evidence_url: vintage.source_url,
    });
  }
  if (raised.value != null) {
    await insertFact(env, {
      entity_id: firmEntityId, predicate: "firm.latest_fund_size_usd",
      source_kind: "scrape", source,
      value_number: raised.value, confidence,
      evidence_url: raised.source_url,
    });
  }
  if (fundEntityId && vintage.value != null) {
    await insertFact(env, {
      entity_id: fundEntityId, predicate: "fund.vintage_year",
      source_kind: "scrape", source,
      value_number: vintage.value, confidence,
      evidence_url: vintage.source_url,
    });
  }

  return {
    fund_id: fundId, firm_entity_id: firmEntityId, fund_name: fundName,
    created: wasNew, evidence_count: evidence.length, status,
  };
}

export function deriveFundStatus(args: {
  firstClose: string | null;
  finalClose: string | null;
  latestFormD: string | null;
  latestLp: string | null;
  pressCorroboration?: boolean;
}): FundStatus {
  const latestSignalDate = mostRecent([args.latestFormD, args.latestLp, args.firstClose]);
  // Raising: recent Form D + no final close + matching press release.
  // Form D alone is insufficient — many shelf filings exist with no
  // active fundraising campaign. Press/blog/tech-press within 18 months
  // of the Form D acts as the corroborating signal.
  if (args.latestFormD && !args.finalClose && monthsSince(args.latestFormD) <= 24 && args.pressCorroboration) {
    return "raising";
  }
  if (!latestSignalDate) return "active";
  const months = monthsSince(latestSignalDate);
  if (months <= 60) return "active";       // 5y
  if (months <= 120) return "harvesting";  // 5–10y
  return "wound_down";
}

function mostRecent(dates: Array<string | null>): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!best || d > best) best = d;
  }
  return best;
}

function monthsSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 999;
  return (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.44);
}

/**
 * Picks the funds that should be (re-)assembled and runs the assembler
 * for each. Idempotent — short-circuits funds whose `updated_at` is
 * fresher than the newest upstream signal (Form D / ADV / LP disclosure
 * / deal event tagging the firm).
 *
 * Discovery path: ADV-filed funds are the seed set. Each
 * (adviser_entity_id, fund_name) tuple is one candidate.
 */
export async function runFundRefreshSweep(env: Env, limit = 50): Promise<{
  picked: number; assembled: number; created: number; skipped: number;
}> {
  // Pick candidates: ADV funds whose adviser is resolved + either no
  // funds row exists OR the funds row is older than the most-recent
  // upstream signal (ADV filing, Form D filing, LP disclosure, or deal
  // event tagging the firm). Re-assemble fires when ANY source moves.
  const rows = await env.DB.prepare(
    `WITH src AS (
       SELECT f.adviser_entity_id AS firm_entity_id,
              f.fund_name,
              MAX(fl.filed_at) AS latest_filed_at
         FROM sec_form_adv_funds f
         LEFT JOIN sec_filings fl ON fl.accession_no = f.accession_no
        WHERE f.adviser_entity_id IS NOT NULL AND f.fund_name IS NOT NULL
        GROUP BY f.adviser_entity_id, f.fund_name
     )
     SELECT s.firm_entity_id, s.fund_name,
            -- Most-recent upstream signal across ADV / Form D / LP / deals.
            MAX(
              COALESCE(s.latest_filed_at, ''),
              COALESCE((SELECT MAX(r.date_of_first_sale) FROM sec_form_d_rounds r
                         WHERE lower(r.issuer_name) LIKE lower('%' || substr(s.fund_name,1,60) || '%')), ''),
              COALESCE((SELECT MAX(lp.as_of_date) FROM lp_fund_commitments lp
                         WHERE lp.fund_entity_id = fu.fund_entity_id), ''),
              COALESCE((SELECT MAX(de.announcement_date) FROM deal_events de
                         JOIN deal_participants dp ON dp.deal_id = de.id
                         WHERE dp.investor_entity_id = s.firm_entity_id), '')
            ) AS latest_signal_at,
            fu.updated_at AS existing_updated_at
       FROM src s
       LEFT JOIN funds fu
         ON fu.firm_entity_id = s.firm_entity_id AND fu.fund_name = s.fund_name
      -- True upstream-change idempotency: reassemble only when a source
      -- signal is newer than the existing funds row's updated_at. New
      -- (never-assembled) pairs always qualify.
      WHERE fu.id IS NULL
         OR fu.updated_at IS NULL
         OR fu.updated_at < MAX(
              COALESCE(s.latest_filed_at, ''),
              COALESCE((SELECT MAX(r.date_of_first_sale) FROM sec_form_d_rounds r
                         WHERE lower(r.issuer_name) LIKE lower('%' || substr(s.fund_name,1,60) || '%')), ''),
              COALESCE((SELECT MAX(lp.as_of_date) FROM lp_fund_commitments lp
                         WHERE lp.fund_entity_id = fu.fund_entity_id), ''),
              COALESCE((SELECT MAX(de.announcement_date) FROM deal_events de
                         JOIN deal_participants dp ON dp.deal_id = de.id
                         WHERE dp.investor_entity_id = s.firm_entity_id), '')
            )
      ORDER BY (fu.updated_at IS NULL) DESC, fu.updated_at ASC NULLS FIRST
      LIMIT ?`,
  ).bind(limit).all<{ firm_entity_id: string; fund_name: string; latest_signal_at: string | null; existing_updated_at: string | null }>();
  let assembled = 0;
  let created = 0;
  let skipped = 0;
  for (const r of rows.results ?? []) {
    try {
      const res = await assembleFund(env, {
        firm_entity_id: r.firm_entity_id,
        fund_name: r.fund_name,
        source: "fund_refresh_sweep",
      });
      assembled++;
      if (res.created) created++;
    } catch (e) {
      skipped++;
      console.warn("assembleFund failed", r.firm_entity_id, r.fund_name, (e as Error).message);
    }
  }
  return { picked: (rows.results ?? []).length, assembled, created, skipped };
}

export type { FundRow };
