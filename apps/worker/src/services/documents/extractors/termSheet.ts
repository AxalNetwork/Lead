// Task #13: Term sheet extractor.
//
// Pulls the standard NVCA-style term list: pre/post-money, raise,
// security type, liquidation preference, anti-dilution, board
// composition, pro-rata, option pool target.

export const TERM_SHEET_EXTRACTOR_VERSION = "1.0.0";

export interface TermSheetExtraction {
  company_name: string | null;
  pre_money_usd: number | null;
  post_money_usd: number | null;
  raise_amount_usd: number | null;
  security_type: string | null;        // preferred_stock | convertible_note | safe
  liquidation_preference_x: number | null;
  liquidation_participating: boolean | null;
  anti_dilution: "broad_based_weighted_average" | "narrow_based_weighted_average" | "full_ratchet" | null;
  board_investor_seats: number | null;
  board_founder_seats: number | null;
  board_independent_seats: number | null;
  option_pool_target_pct: number | null;
  pro_rata: boolean;
  warnings: string[];
  /** Task #18: raw extracted text retained on the payload so the
   *  document-persist fanout (services/documents/persist.ts) can run
   *  the per-series preferred-stack parser against the same source
   *  text that produced the headline NVCA fields. Capped at 200kB to
   *  bound JSON envelope size; the per-series parser internally caps
   *  its working window at 60kB. */
  raw_text: string;
}

function parseUsd(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|m|mm|b|bn)?$/.exec(t);
  if (!m) { const n = Number(t); return Number.isFinite(n) ? Math.round(n) : null; }
  const v = Number(m[1]);
  const mult = m[2] === "k" ? 1e3 : (m[2] === "m" || m[2] === "mm") ? 1e6 : (m[2] === "b" || m[2] === "bn") ? 1e9 : 1;
  return Math.round(v * mult);
}

export function extractTermSheet(text: string): TermSheetExtraction {
  const warnings: string[] = [];

  const preM = /pre-?money[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const postM = /post-?money[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const raiseM = /(?:raise|amount\s+raised|round\s+size|new\s+money|investment)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const pre_money_usd = preM ? parseUsd(preM[1]) : null;
  const post_money_usd = postM ? parseUsd(postM[1]) : null;
  const raise_amount_usd = raiseM ? parseUsd(raiseM[1]) : null;

  const security_type =
    /series\s+[a-z]\s+preferred/i.test(text) ? "preferred_stock" :
    /convertible\s+note/i.test(text) ? "convertible_note" :
    /\bsafe\b/i.test(text) ? "safe" :
    /preferred\s+stock/i.test(text) ? "preferred_stock" : null;

  const lpM = /(\d(?:\.\d+)?)\s*x\s*(?:non-?participating|participating)?\s*liquidation\s+preference/i.exec(text);
  const liquidation_preference_x = lpM ? Number(lpM[1]) : (/liquidation\s+preference/i.test(text) ? 1 : null);
  const liquidation_participating =
    /participating(?:\s+preferred)?/i.test(text) && !/non-?participating/i.test(text) ? true :
    /non-?participating/i.test(text) ? false : null;

  const anti_dilution: TermSheetExtraction["anti_dilution"] =
    /broad[-\s]?based\s+weighted\s+average/i.test(text) ? "broad_based_weighted_average" :
    /narrow[-\s]?based\s+weighted\s+average/i.test(text) ? "narrow_based_weighted_average" :
    /full[-\s]?ratchet/i.test(text) ? "full_ratchet" : null;

  // Board composition: "Board: 2 investor / 2 founder / 1 independent"
  const boardSection = /board\s+composition[^\n]{0,300}|board\s+of\s+directors[^\n]{0,300}/i.exec(text);
  const boardTxt = boardSection?.[0] ?? text;
  const invSeatsM = /(\d)\s*(?:investor|preferred|series)/i.exec(boardTxt);
  const fndSeatsM = /(\d)\s*(?:founder|common)/i.exec(boardTxt);
  const indSeatsM = /(\d)\s*(?:independent|mutually\s+agreed)/i.exec(boardTxt);
  const board_investor_seats = invSeatsM ? Number(invSeatsM[1]) : null;
  const board_founder_seats = fndSeatsM ? Number(fndSeatsM[1]) : null;
  const board_independent_seats = indSeatsM ? Number(indSeatsM[1]) : null;

  const poolM = /(?:option\s+pool|esop)[^\d%]{0,60}(\d{1,2}(?:\.\d+)?)\s*%/i.exec(text);
  const option_pool_target_pct = poolM ? Number(poolM[1]) / 100 : null;

  const pro_rata = /pro[\s-]?rata\s+right/i.test(text);

  const coM = /(?:company|issuer)[\s:]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i.exec(text);
  const company_name = coM ? coM[1].trim().replace(/[,.]$/, "") : null;

  if (pre_money_usd == null && post_money_usd == null) warnings.push("no_valuation");
  if (security_type == null) warnings.push("no_security_type");

  return {
    company_name, pre_money_usd, post_money_usd, raise_amount_usd,
    security_type, liquidation_preference_x, liquidation_participating,
    anti_dilution, board_investor_seats, board_founder_seats,
    board_independent_seats, option_pool_target_pct, pro_rata, warnings,
    raw_text: text.slice(0, 200_000),
  };
}
