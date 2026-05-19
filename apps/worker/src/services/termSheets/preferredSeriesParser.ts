// Task #18: Preferred-stock series extractor.
//
// Locates the "Description of Capital Stock" section in an S-1 / 8-K
// Item 3.03 / Delaware COI / operator-uploaded term sheet and emits
// one ParsedSeries per preferred series found.
//
// Design contract (per spec step 2):
//   - Each per-term regex output flows through a strict post-validator:
//     * participating → must have numeric cap OR be uncapped
//     * lp multiple   → must be positive
//     * anti_dilution → must be one of the four enum values
//   - The parser returns warnings rather than throwing; downstream
//     persist layer is responsible for the confidence-driven gate.

export type AntiDilution = "full_ratchet" | "broad_weighted" | "narrow_weighted" | "none";
export type Stage = "pre_seed" | "seed" | "series_a" | "series_b" | "series_c" | "series_d_plus";

export interface ParsedSeries {
  series_name: string;              // normalized: "Series A", "Series A-1", "Series Seed"
  series_letter: string;            // "A", "A-1", "Seed", "Pre-Seed"
  original_issue_price_usd: number | null;
  pre_money_usd: number | null;
  raise_amount_usd: number | null;
  liquidation_pref_x: number | null;
  participating: boolean | null;
  participating_cap_x: number | null;
  anti_dilution: AntiDilution | null;
  dividend_rate_pct: number | null;
  dividend_cumulative: boolean | null;
  conversion_ratio: number | null;
  protective_provisions_count: number | null;
  redemption_rights: boolean | null;
  board_total: number | null;
  board_investor_seats: number | null;
  board_founder_seats: number | null;
  board_independent_seats: number | null;
  lead_investor_names: string[];
  investor_names: string[];
  stage: Stage;
  closing_date: string | null;
  confidence: number;
  warnings: string[];
}

export interface PreferredStackExtraction {
  company_name: string | null;
  series: ParsedSeries[];
  warnings: string[];
}

const SERIES_HEADER_RE =
  /\b(Series\s+(?:Seed|Pre[-\s]?Seed|[A-Z](?:-?\d)?(?:-\d+)?))\s+Preferred\s+Stock\b/gi;

function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function locateCapitalStockSection(text: string): string {
  // EDGAR S-1 sections are typically headed by "DESCRIPTION OF CAPITAL STOCK".
  // 8-K Item 3.03 sections are headed by "Item 3.03" and we keep ~6kB after.
  const dcs = text.search(/Description\s+of\s+(?:Our\s+)?Capital\s+Stock/i);
  if (dcs >= 0) {
    // Take up to 60kB so multi-series filings (Stripe, Airbnb, …) fit.
    return text.slice(dcs, Math.min(text.length, dcs + 60_000));
  }
  const it303 = text.search(/Item\s+3\.03\b/i);
  if (it303 >= 0) {
    return text.slice(it303, Math.min(text.length, it303 + 10_000));
  }
  // Fall back to whole text (e.g. operator-pasted termsheet) but
  // capped — preferred-stack parsers run inline on the Workers CPU
  // budget per Task #13's inline-extraction note.
  return text.slice(0, 80_000);
}

function parseUsd(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|m|mm|b|bn)?$/.exec(t);
  if (!m) { const n = Number(t); return Number.isFinite(n) ? n : null; }
  const v = Number(m[1]);
  const mult = m[2] === "k" ? 1e3 : (m[2] === "m" || m[2] === "mm") ? 1e6 : (m[2] === "b" || m[2] === "bn") ? 1e9 : 1;
  return v * mult;
}

function normalizeSeriesName(raw: string): { name: string; letter: string; stage: Stage } {
  const t = raw.replace(/\s+Preferred\s+Stock\b/i, "").trim();
  // "Series Seed", "Series Pre-Seed", "Series A-1"
  const m = /Series\s+(Seed|Pre[-\s]?Seed|[A-Z](?:-?\d)?(?:-\d+)?)/i.exec(t);
  const letterRaw = (m?.[1] ?? "?").replace(/\s+/g, "-");
  const letter = /^Pre/i.test(letterRaw) ? "Pre-Seed" : letterRaw;
  const upper = letter.toUpperCase();
  const stage: Stage =
    /^PRE-?SEED$/i.test(letter) ? "pre_seed" :
    /^SEED$/i.test(letter) ? "seed" :
    /^A/.test(upper) ? "series_a" :
    /^B/.test(upper) ? "series_b" :
    /^C/.test(upper) ? "series_c" :
    "series_d_plus";
  return { name: `Series ${letter}`, letter, stage };
}

/** Validate per-spec post-rules. Mutates warnings. */
function postValidate(s: ParsedSeries): void {
  if (s.liquidation_pref_x != null && !(s.liquidation_pref_x > 0)) {
    s.warnings.push("invalid_lp_x_nonpositive");
    s.liquidation_pref_x = null;
  }
  if (s.participating === true) {
    // Strict spec rule: participating → must have numeric cap OR be uncapped.
    // "uncapped" is represented by participating_cap_x === null AND a
    // textual signal of "without cap"/"unlimited". If we can't determine
    // one way or the other, downgrade confidence and warn.
    if (s.participating_cap_x == null && !s.warnings.includes("participating_uncapped_explicit")) {
      s.warnings.push("participating_cap_unknown");
      s.confidence = Math.min(s.confidence, 0.5);
    }
  }
  if (s.anti_dilution != null &&
      !["full_ratchet", "broad_weighted", "narrow_weighted", "none"].includes(s.anti_dilution)) {
    s.warnings.push("invalid_anti_dilution_enum");
    s.anti_dilution = null;
  }
}

function extractOneSeries(window: string, headerMatch: { name: string; letter: string; stage: Stage }, closingDate: string | null): ParsedSeries {
  const w = window.slice(0, 6000);
  const warnings: string[] = [];

  // Original issue price: "$5.00 per share" near series header
  const oipM = /(?:Original\s+Issue\s+Price|purchase\s+price)[^$]{0,80}\$\s*([\d,.]+)\s*per\s+share/i.exec(w);
  const original_issue_price_usd = oipM ? parseUsd(oipM[1]) : null;

  // Liquidation preference: "1x", "1.5x", "two times"
  const lpM = /(\d(?:\.\d+)?)\s*x\s*(?:(?:non[-\s]?)?participating)?\s*(?:the\s+)?(?:original\s+issue\s+price|liquidation\s+preference)/i.exec(w);
  const lpWordM = /(one|two|three)\s+times\s+(?:the\s+)?(?:original\s+issue\s+price|liquidation\s+preference)/i.exec(w);
  const liquidation_pref_x =
    lpM ? Number(lpM[1]) :
    lpWordM ? ({ one: 1, two: 2, three: 3 } as Record<string, number>)[lpWordM[1].toLowerCase()] ?? null :
    /liquidation\s+preference/i.test(w) ? 1 : null;

  // Participating? "participating" without "non-participating"
  const isNonPart = /non[-\s]?participating/i.test(w);
  const isPart = /participating(?:\s+preferred)?/i.test(w) && !isNonPart;
  const participating = isPart ? true : isNonPart ? false : null;

  // Cap: "subject to a cap of 2x" / "capped at three times" / "without cap"
  let participating_cap_x: number | null = null;
  if (participating) {
    const capM = /(?:cap(?:ped)?\s+(?:of|at)\s+|aggregate\s+(?:return|payments?)\s+of\s+)(\d(?:\.\d+)?)\s*x/i.exec(w);
    const capWordM = /capped\s+at\s+(one|two|three)\s+times/i.exec(w);
    const uncapped = /(?:without\s+(?:any\s+)?cap|uncapped|no\s+(?:aggregate\s+)?cap)/i.test(w);
    if (uncapped) {
      participating_cap_x = null;
      warnings.push("participating_uncapped_explicit");
    } else if (capM) {
      participating_cap_x = Number(capM[1]);
    } else if (capWordM) {
      participating_cap_x = ({ one: 1, two: 2, three: 3 } as Record<string, number>)[capWordM[1].toLowerCase()] ?? null;
    }
  }

  // Anti-dilution
  const anti_dilution: AntiDilution | null =
    /broad[-\s]?based\s+weighted[-\s]?average/i.test(w) ? "broad_weighted" :
    /narrow[-\s]?based\s+weighted[-\s]?average/i.test(w) ? "narrow_weighted" :
    /full[-\s]?ratchet/i.test(w) ? "full_ratchet" :
    /no\s+anti[-\s]?dilution|anti[-\s]?dilution\s+protection\s+(?:does\s+not|shall\s+not)/i.test(w) ? "none" :
    null;

  // Dividend rate
  const divM = /(?:dividend|dividends?)\s+(?:at\s+(?:an?\s+annual\s+)?rate\s+of\s+)?(\d{1,2}(?:\.\d+)?)\s*%/i.exec(w);
  const dividend_rate_pct = divM ? Number(divM[1]) / 100 : null;
  const dividend_cumulative =
    /\bcumulative\s+dividend/i.test(w) ? true :
    /non[-\s]?cumulative/i.test(w) ? false : null;

  // Conversion ratio: "convertible into Common Stock at a ratio of 1:1"
  const convM = /convert(?:ible)?[^.]{0,200}\bratio\s+of\s+(\d(?:\.\d+)?)\s*[:/to-]+\s*(\d(?:\.\d+)?)/i.exec(w);
  const conversion_ratio = convM ? Number(convM[1]) / Number(convM[2]) :
    /convert(?:ible)?[^.]{0,200}\bone[-\s]?for[-\s]?one/i.test(w) ? 1 : null;

  // Protective provisions: count enumerated items in "Protective Provisions"
  // sub-section (numbered or bulleted).
  let protective_provisions_count: number | null = null;
  const ppIdx = w.search(/Protective\s+Provisions/i);
  if (ppIdx >= 0) {
    const ppBlock = w.slice(ppIdx, ppIdx + 2500);
    const items = ppBlock.match(/\(\s*[a-z]\s*\)|\(\s*\d+\s*\)|\b\d+\.\s|\u2022/g) ?? [];
    if (items.length > 0) protective_provisions_count = Math.min(items.length, 30);
  }

  // Redemption rights
  const redemption_rights = /\bredemption\s+(?:right|of|at)/i.test(w) && !/no\s+redemption/i.test(w) ? true :
    /no\s+redemption|not\s+redeemable/i.test(w) ? false : null;

  // Board composition (matches the existing termSheet extractor patterns)
  let board_total: number | null = null;
  let board_investor_seats: number | null = null;
  let board_founder_seats: number | null = null;
  let board_independent_seats: number | null = null;
  const boardIdx = w.search(/Board\s+(?:Composition|of\s+Directors)/i);
  if (boardIdx >= 0) {
    const bb = w.slice(boardIdx, boardIdx + 1200);
    const totalM = /board\s+of\s+(\d{1,2})\s+directors/i.exec(bb) ?? /(\d{1,2})\s*member\s+board/i.exec(bb);
    if (totalM) board_total = Number(totalM[1]);
    const inv = /(\d)\s*(?:director[s]?\s*)?(?:elected|designated|appointed)?\s*by\s*the\s*(?:Series|Preferred|investors?)/i.exec(bb);
    const fnd = /(\d)\s*(?:director[s]?\s*)?(?:elected|designated|appointed)?\s*by\s*the\s*(?:Common|founders?)/i.exec(bb);
    const ind = /(\d)\s*(?:director[s]?\s*)?(?:independent|mutually\s+agreed)/i.exec(bb);
    if (inv) board_investor_seats = Number(inv[1]);
    if (fnd) board_founder_seats = Number(fnd[1]);
    if (ind) board_independent_seats = Number(ind[1]);
    if (board_total == null && (board_investor_seats != null || board_founder_seats != null || board_independent_seats != null)) {
      board_total = (board_investor_seats ?? 0) + (board_founder_seats ?? 0) + (board_independent_seats ?? 0) || null;
    }
  }

  // Investor names from "Schedule of Investors" or "Lead Investor" callouts.
  // Best-effort; the persist layer is responsible for name→entity resolution.
  const leadM = /(?:lead\s+investor[s]?\s*[:\s]+)([A-Z][A-Za-z0-9 &.,'\-]{2,120})/i.exec(w);
  const lead_investor_names = leadM ? [leadM[1].trim().split(/\s+and\s+|,/).map((s) => s.trim()).filter((s) => s.length > 1)].flat().slice(0, 10) : [];
  const investor_names: string[] = [];
  const invRe = /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:Capital|Ventures|Partners|Holdings|Fund|Management|Equity|Group|VC))/g;
  let m: RegExpExecArray | null;
  while ((m = invRe.exec(w)) && investor_names.length < 25) {
    if (!investor_names.includes(m[1])) investor_names.push(m[1]);
  }

  // Pre-money / raise: scoped to this series window
  const preM = /pre-?money[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(w);
  const raiseM = /(?:raise|round\s+size|aggregate\s+(?:gross\s+)?proceeds)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(w);

  // Confidence: 0.5 baseline + 0.1 per core term resolved.
  const coreTerms = [liquidation_pref_x, participating, anti_dilution, original_issue_price_usd].filter((x) => x != null).length;
  const confidence = Math.min(0.95, 0.5 + 0.1 * coreTerms);

  const out: ParsedSeries = {
    series_name: headerMatch.name,
    series_letter: headerMatch.letter,
    original_issue_price_usd,
    pre_money_usd: preM ? parseUsd(preM[1]) : null,
    raise_amount_usd: raiseM ? parseUsd(raiseM[1]) : null,
    liquidation_pref_x,
    participating,
    participating_cap_x,
    anti_dilution,
    dividend_rate_pct,
    dividend_cumulative,
    conversion_ratio,
    protective_provisions_count,
    redemption_rights,
    board_total,
    board_investor_seats,
    board_founder_seats,
    board_independent_seats,
    lead_investor_names,
    investor_names,
    stage: headerMatch.stage,
    closing_date: closingDate,
    confidence,
    warnings,
  };
  postValidate(out);
  return out;
}

export function extractPreferredStack(input: string, opts: { closingDate?: string | null; companyName?: string | null } = {}): PreferredStackExtraction {
  const text = /<[a-z][^>]*>/i.test(input) ? stripTags(input) : input;
  const section = locateCapitalStockSection(text);
  const warnings: string[] = [];
  const series: ParsedSeries[] = [];
  const seen = new Set<string>();

  // Walk every Series header in the section and slice ~6kB after as
  // the per-series window. Series sections are typically presented in
  // descending letter order (most recent first) in the S-1.
  const rawMatches: Array<{ index: number; raw: string }> = [];
  let mm: RegExpExecArray | null;
  SERIES_HEADER_RE.lastIndex = 0;
  while ((mm = SERIES_HEADER_RE.exec(section))) {
    rawMatches.push({ index: mm.index, raw: mm[0] });
  }
  // Dedupe by series-name BEFORE slicing windows, so re-mentions of the
  // same series inside its own narrative ("The Series B Preferred Stock
  // carries…") don't truncate the window to ~30 chars. First occurrence
  // of each unique series wins; the window for series N extends to the
  // first mention of series N+1 (the next *different* series).
  const matches: Array<{ index: number; raw: string; name: string }> = [];
  for (const m of rawMatches) {
    const h = normalizeSeriesName(m.raw);
    if (seen.has(h.name)) continue;
    seen.add(h.name);
    matches.push({ ...m, name: h.name });
  }
  for (let i = 0; i < matches.length; i++) {
    const header = normalizeSeriesName(matches[i].raw);
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(section.length, start + 8000);
    const win = section.slice(start, end);
    const s = extractOneSeries(win, header, opts.closingDate ?? null);
    if (s.liquidation_pref_x == null && s.anti_dilution == null && s.participating == null) {
      // No core term resolved — drop the row, surface a warning.
      warnings.push(`series_${header.letter}_no_core_terms`);
      continue;
    }
    series.push(s);
  }

  const companyName = opts.companyName ?? (
    /(?:we\s+are\s+|the\s+Company,\s+|"Company"\s*means\s+)([A-Z][A-Za-z0-9 ,.&'\-]{2,80})\s+(?:Inc|Corp|LLC|Ltd|Limited)/i.exec(text)?.[1] ?? null
  );

  return { company_name: companyName, series, warnings };
}
