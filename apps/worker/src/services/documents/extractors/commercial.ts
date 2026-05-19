// Task #13: Commercial contract extractor.
//
// Pulls ACV / TCV / term / auto-renew / payment terms from MSA-style
// commercial agreements.

export const COMMERCIAL_EXTRACTOR_VERSION = "1.0.0";

export interface CommercialExtraction {
  parties: string[];
  acv_usd: number | null;
  tcv_usd: number | null;
  term_months: number | null;
  auto_renew: boolean;
  notice_period_days: number | null;
  payment_terms_days: number | null;
  governing_law: string | null;
  warnings: string[];
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

export function extractCommercial(text: string): CommercialExtraction {
  const warnings: string[] = [];
  const acvM = /(?:annual\s+contract\s+value|\bacv\b|annual\s+fees?)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const tcvM = /(?:total\s+contract\s+value|\btcv\b)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const acv_usd = acvM ? parseUsd(acvM[1]) : null;
  const tcv_usd = tcvM ? parseUsd(tcvM[1]) : null;

  const termM = /(?:initial\s+term|term\s+of\s+this\s+agreement|subscription\s+term)[^\d]{0,40}(\d{1,3})\s*(month|year)s?/i.exec(text);
  let term_months: number | null = null;
  if (termM) term_months = termM[2].toLowerCase() === "year" ? Number(termM[1]) * 12 : Number(termM[1]);

  const auto_renew = /(auto[-\s]?renew|automatically\s+renew|automatic\s+renewal)/i.test(text);
  const noticeM = /(?:notice\s+(?:of\s+)?(?:non[-\s]?renewal|termination))[^\d]{0,60}(\d{1,3})\s*days/i.exec(text);
  const notice_period_days = noticeM ? Number(noticeM[1]) : null;

  const ptM = /net\s+(\d{1,3})/i.exec(text);
  const payment_terms_days = ptM ? Number(ptM[1]) : null;

  const lawM = /governed\s+by\s+the\s+laws?\s+of(?:\s+the\s+state\s+of)?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/i.exec(text);
  const governing_law = lawM ? lawM[1].trim() : null;

  // Parties: look for "between A and B" / "Customer:" / "Vendor:"
  const parties: string[] = [];
  const betweenM = /between\s+([A-Z][A-Za-z0-9 &.,'\-]{2,80})\s+and\s+([A-Z][A-Za-z0-9 &.,'\-]{2,80})/i.exec(text);
  if (betweenM) parties.push(betweenM[1].trim(), betweenM[2].trim());

  if (acv_usd == null && tcv_usd == null) warnings.push("no_contract_value");
  return {
    parties, acv_usd, tcv_usd, term_months, auto_renew,
    notice_period_days, payment_terms_days, governing_law, warnings,
  };
}
