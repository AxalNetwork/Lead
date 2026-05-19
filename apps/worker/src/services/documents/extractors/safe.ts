// Task #13: SAFE extractor.
//
// Pulls cap / discount / MFN / pre-money-vs-post-money / investor /
// purchase amount from a SAFE document text. Regex-based; the YC
// standard SAFEs and most variants use stable boilerplate that the
// patterns below were derived from.

export const SAFE_EXTRACTOR_VERSION = "1.0.0";

export interface SafeExtraction {
  variant: "post_money" | "pre_money" | "unknown";
  purchase_amount_usd: number | null;
  valuation_cap_usd: number | null;
  discount_pct: number | null;
  mfn: boolean;
  pro_rata: boolean;
  investor_name: string | null;
  company_name: string | null;
  effective_date: string | null;        // ISO YYYY-MM-DD when parseable
  warnings: string[];
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function parseUsd(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|m|mm|b|bn)?$/.exec(t);
  if (!m) {
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const v = Number(m[1]);
  const mult = m[2] === "k" ? 1e3 : (m[2] === "m" || m[2] === "mm") ? 1e6 : (m[2] === "b" || m[2] === "bn") ? 1e9 : 1;
  return Math.round(v * mult);
}

function parseDateLoose(raw: string | null): string | null {
  if (!raw) return null;
  const m1 = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})/i.exec(raw);
  if (m2) return `${m2[3]}-${MONTHS[m2[1].toLowerCase()]}-${String(m2[2]).padStart(2, "0")}`;
  return null;
}

export function extractSafe(text: string): SafeExtraction {
  const warnings: string[] = [];
  const lower = text.toLowerCase();

  const variant: SafeExtraction["variant"] =
    /post-?money\s+safe/i.test(text) ? "post_money" :
    /pre-?money\s+safe/i.test(text) ? "pre_money" :
    "unknown";
  if (variant === "unknown") warnings.push("variant_unknown");

  const purchaseM = /(?:purchase\s+amount|investment\s+amount|amount\s+invested)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const purchase_amount_usd = purchaseM ? parseUsd(purchaseM[1]) : null;

  const capM = /(?:valuation\s+cap|post-?money\s+valuation\s+cap|cap\s+amount)[^$]{0,40}\$\s*([\d,.]+(?:\s*(?:k|m|mm|b|bn))?)/i.exec(text);
  const valuation_cap_usd = capM ? parseUsd(capM[1]) : null;
  if (valuation_cap_usd == null) warnings.push("cap_not_found");

  const discM = /(?:discount\s+rate|discount)[^\d%]{0,40}(\d{1,2}(?:\.\d+)?)\s*%/i.exec(text);
  const discount_pct = discM ? Number(discM[1]) / 100 : null;

  const mfn = /(most\s+favored\s+nation|\bmfn\b)/i.test(lower);
  const pro_rata = /(pro[\s-]?rata\s+right|side\s+letter)/i.test(lower);

  const invM = /(?:investor|purchaser)[\s:]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i.exec(text);
  const investor_name = invM ? invM[1].trim().replace(/[,.]$/, "") : null;

  const coM = /(?:company|issuer)[\s:]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})(?:,?\s*(?:inc|llc|corp|ltd|gmbh|sas|sa))?/i.exec(text);
  const company_name = coM ? coM[1].trim().replace(/[,.]$/, "") : null;

  const dateM = /(?:effective\s+date|dated\s+as\s+of|date)[\s:]+([^\n,]{4,40})/i.exec(text);
  const effective_date = parseDateLoose(dateM?.[1] ?? null);

  return {
    variant, purchase_amount_usd, valuation_cap_usd, discount_pct,
    mfn, pro_rata, investor_name, company_name, effective_date, warnings,
  };
}
