// Task #5: Delaware Certificate-of-Incorporation parser (preferred
// stock authorization + series count only).
//
// Delaware corporate-records are public via the DE Division of
// Corporations search portal, but a full COI extraction would require
// purchasing each filing as a PDF. The free metadata path
// (corp.delaware.gov entity search) gives us:
//   - entity registered name + file_number
//   - incorporation date
//   - status (active / cancelled / merged)
//
// That alone is not a cap table, but it tells us how MANY shares the
// charter authorizes by class — when a COI text is supplied (e.g.
// uploaded by an operator, or fetched from Carta filings index), this
// parser extracts the authorized-shares grid.
//
// COIs follow Section 102(a)(4) DGCL boilerplate; the relevant block
// looks like:
//
//   "The Corporation is authorized to issue two classes of shares,
//    designated Common Stock and Preferred Stock. The total number of
//    shares of Common Stock authorized to be issued is 200,000,000,
//    par value $0.00001 per share. The total number of shares of
//    Preferred Stock authorized to be issued is 50,000,000, par value
//    $0.00001 per share."
//
// Series breakdowns appear in amendments ("Certificate of
// Designation"):
//
//   "Series A Preferred Stock — 12,500,000 shares … Series B Preferred
//    Stock — 8,750,000 shares …"
//
// We return ONE snapshot input per parsed COI. holders are synthesized
// as authorization rows (one per class/series) with holder_class =
// "unknown" — a COI doesn't disclose who owns the shares, only that
// the class exists.

import type { CapTableHolderInput } from "./types";
import { classifySecurity } from "./normalize";

const CLASS_AUTH_RE =
  /(common\s+stock|preferred\s+stock|series\s+[a-h]\s+preferred\s+stock|series\s+[a-h]\s+stock)[^.]{0,200}?(?:authoriz(?:ed|ation)|issue[d]?)[^.]{0,80}?(\d[\d,]{3,})/gi;

const PAR_VALUE_RE = /par\s+value\s+\$?(\d+(?:\.\d+)?)/i;

export interface DeCoiExtractResult {
  ok: boolean;
  reason?: string;
  total_authorized: number | null;
  par_value_usd: number | null;
  holders: CapTableHolderInput[];
}

export function extractDelawareCoi(text: string): DeCoiExtractResult {
  if (!text || text.length < 100) {
    return { ok: false, reason: "text_too_short", total_authorized: null, par_value_usd: null, holders: [] };
  }
  const holders: CapTableHolderInput[] = [];
  let m: RegExpExecArray | null;
  CLASS_AUTH_RE.lastIndex = 0;
  while ((m = CLASS_AUTH_RE.exec(text)) !== null) {
    const className = m[1].replace(/\s+/g, " ").trim();
    const shares = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(shares) || shares < 1) continue;
    const security = classifySecurity(className);
    holders.push({
      holder_name_raw: `Authorized: ${className}`,
      holder_class: "unknown",
      security_type: security,
      shares,
      pct_ownership: null,
      notes: "Authorized but not necessarily issued.",
    });
  }
  if (!holders.length) {
    return { ok: false, reason: "no_authorization_clauses_matched", total_authorized: null, par_value_usd: null, holders: [] };
  }
  const total = holders.reduce((a, h) => a + (h.shares ?? 0), 0);
  const par = PAR_VALUE_RE.exec(text);
  return {
    ok: true,
    total_authorized: total || null,
    par_value_usd: par ? Number(par[1]) : null,
    holders,
  };
}
