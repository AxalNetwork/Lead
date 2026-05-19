// Task #9: SEC N-PORT XML parser (mutual-fund holdings).
//
// Mutual funds (Fidelity, T. Rowe Price, BlackRock) file Form N-PORT-P
// quarterly. Each filing includes an `<invstOrSec>` block per holding
// disclosing name, valuation (USD), holding type, percent of net assets,
// and "level 3" fair-value indicator. Private-company holdings appear
// alongside public ones; we filter by `<assetCat>EC</assetCat>` (equity-
// common / equity-preferred) AND `<isRestrictedSec>Y` OR explicit "fair
// value level 3" flag, since publicly tradable equity wouldn't be a
// mark on a private company.
//
// Pure extraction — no network.

export interface NportHolding {
  issuer_name: string;
  cusip?: string | null;
  value_usd: number | null;
  pct_of_net_assets: number | null;
  is_restricted: boolean;
  fair_value_level: number | null;
  asset_category: string | null;
}

export interface NportExtractResult {
  ok: boolean;
  reason?: string;
  fund_name: string | null;
  period_of_report: string | null;
  holdings: NportHolding[];
}

function pickTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

function parseNumber(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,$\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

export function extractNportHoldings(xml: string): NportExtractResult {
  if (!xml || xml.length < 200) {
    return { ok: false, reason: "empty_xml", fund_name: null, period_of_report: null, holdings: [] };
  }
  // The fund's own name lives under <regName> or <seriesName>.
  const fundName = pickTag(xml, "regName") ?? pickTag(xml, "seriesName") ?? null;
  const period = pickTag(xml, "repPdEnd") ?? pickTag(xml, "periodOfReport") ?? null;

  const holdings: NportHolding[] = [];
  // <invstOrSec> blocks (one per holding).
  const re = /<invstOrSec[^>]*>([\s\S]*?)<\/invstOrSec>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const name = pickTag(block, "name") ?? pickTag(block, "issuerName");
    if (!name) continue;
    const cusip = pickTag(block, "cusip");
    const valUsd = parseNumber(pickTag(block, "valUSD"));
    const pctVal = parseNumber(pickTag(block, "pctVal"));
    const assetCat = pickTag(block, "assetCat");
    const isRestricted = /<isRestrictedSec>\s*Y\s*</i.test(block);
    const lvl = parseNumber(pickTag(block, "fairValLevel"));
    holdings.push({
      issuer_name: name,
      cusip: cusip ?? null,
      value_usd: valUsd,
      pct_of_net_assets: pctVal,
      is_restricted: isRestricted,
      fair_value_level: lvl,
      asset_category: assetCat,
    });
  }
  return {
    ok: holdings.length > 0,
    reason: holdings.length ? undefined : "no_holdings",
    fund_name: fundName,
    period_of_report: period,
    holdings,
  };
}

/** Filter N-PORT holdings to ones plausibly representing a private-
 *  company mark: equity asset category AND (restricted OR Level-3
 *  fair-valued). Publicly tradable holdings are excluded. */
export function filterPrivateCompanyHoldings(rows: NportHolding[]): NportHolding[] {
  return rows.filter((h) => {
    if (h.value_usd == null || h.value_usd <= 0) return false;
    const isEquity = h.asset_category != null && /^EC|^EP/i.test(h.asset_category);
    if (!isEquity) return false;
    return h.is_restricted || (h.fair_value_level != null && h.fair_value_level >= 3);
  });
}
