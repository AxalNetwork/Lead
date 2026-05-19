// Task #5: holder name + share/percentage normalization helpers.
//
// Shared by all five inference paths so resolved holder ids collapse
// consistently. Mirrors the conventions in services/deals/dedupe.ts
// (normalizeCompanyName) — we cannot import that directly because the
// dedupe variant strips trailing entity suffixes only for COMPANIES;
// here we need a slightly different variant that also tolerates fund
// vehicle suffixes ("Fund III, L.P.", "Capital Partners II").

import type { HolderClass, SecurityType } from "./types";

const LEGAL_SUFFIX_RE =
  /\b(inc\.?|incorporated|corp\.?|corporation|llc|llp|l\.p\.|lp|ltd\.?|limited|gmbh|s\.a\.?|s\.p\.a\.?|n\.v\.?|b\.v\.?|plc|holding|holdings|co\.?|company|company,?|trust|the)\b/gi;
const FUND_SUFFIX_RE =
  /\b(fund|partners|capital|ventures|investments|management|advisors|group)\s*(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|\d{1,3})?\b/gi;

export function normalizeHolderName(raw: string | null | undefined): string {
  if (!raw) return "";
  let n = String(raw).toLowerCase().trim();
  // Strip parens/brackets blocks: "Sequoia Capital (Cayman)" → "Sequoia Capital"
  n = n.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // Strip dotted legal forms before flattening punctuation, so "L.P."
  // and "S.A." are caught before they degrade to "l p" / "s a".
  n = n.replace(LEGAL_SUFFIX_RE, " ");
  // Now flatten remaining punctuation and a few residual dotted forms.
  n = n.replace(/[,.;:'"`]/g, " ");
  n = n.replace(/\b(l\s*p|l\s*l\s*c|l\s*l\s*p|s\s*a|n\s*v|b\s*v|s\s*p\s*a)\b/g, " ");
  // Fund-vehicle suffix folding: keep the head ("Fund"), drop the roman/digit.
  n = n.replace(FUND_SUFFIX_RE, " $1 ");
  // Strip a generic trailing "markets" / "advisors" descriptor when it
  // follows a fund-shaped head word, so "Capital Markets" → "Capital".
  n = n.replace(/\b(capital|partners|fund|ventures|investments)\s+(markets|advisors?|group)\b/g, " $1 ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/^the\s+/i, "").trim();
  return n;
}

export function parseShareCount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[,$\s]/g, "").trim();
  if (!s || s === "—" || s === "-" || s === "*" || /n\/?a/i.test(s)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parsePercent(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[,\s]/g, "").trim();
  if (!s || s === "—" || s === "-" || s === "*" || /n\/?a/i.test(s)) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // Tables sometimes print 12.3 (meaning %) and sometimes 0.123 (fraction).
  // Anything > 1 is interpreted as percent; otherwise as a fraction.
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

export function parseUsd(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[,\s$]/g, "").trim();
  if (!s) return null;
  let mult = 1;
  let body = s;
  if (/k$/i.test(s))      { mult = 1_000;         body = s.slice(0, -1); }
  else if (/m$/i.test(s)) { mult = 1_000_000;     body = s.slice(0, -1); }
  else if (/b$/i.test(s)) { mult = 1_000_000_000; body = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(body)) return null;
  const n = Number(body) * mult;
  return Number.isFinite(n) ? Math.round(n) : null;
}

const SERIES_RE = /\bseries\s+([a-h])\b/i;
const PREFERRED_RE = /\bpreferred\b/i;
const COMMON_RE = /\bcommon\b/i;
const OPTION_RE = /\b(option|esop|rsu|equity\s+incentive)\b/i;
const WARRANT_RE = /\bwarrant\b/i;
const SAFE_RE = /\bsafe\b/i;
const NOTE_RE = /\b(convertible|convert\.?)\s*note\b/i;

export function classifySecurity(label: string | null | undefined): SecurityType {
  if (!label) return "unknown";
  const s = String(label);
  const m = SERIES_RE.exec(s);
  if (m) {
    const letter = m[1].toLowerCase();
    if ("abcdefgh".includes(letter)) return (`preferred_${letter}`) as SecurityType;
  }
  if (NOTE_RE.test(s)) return "convertible_note";
  if (SAFE_RE.test(s)) return "safe";
  if (WARRANT_RE.test(s)) return "warrant";
  if (OPTION_RE.test(s)) return "option";
  if (PREFERRED_RE.test(s)) return "preferred";
  if (COMMON_RE.test(s)) return "common";
  return "unknown";
}

/** Heuristic holder-class bucketing from name + security type. */
export function classifyHolder(name: string, security: SecurityType): HolderClass {
  const n = name.toLowerCase();
  if (security === "option" || /esop|equity\s+incentive|employee\s+pool/i.test(n)) {
    return /unallocated|reserve|pool/i.test(n) ? "esop_unallocated" : "employee_pool";
  }
  if (/founder|co-?founder/i.test(n)) return "founder";
  // Heuristic: holders with fund-vehicle words are investors; persons fall to common.
  const isFundShape = /capital|ventures?|partners|fund\b|investments?|management|growth|holdings?|family\s+office|trust\b/i.test(n);
  if (security === "common") return isFundShape ? "common_investor" : "founder";
  if (security.startsWith("preferred") || security === "safe" || security === "convertible_note") {
    return "preferred_investor";
  }
  if (isFundShape) return "preferred_investor";
  // Person-shaped fallback: 2–4 word names with no fund tokens and no
  // digits read as a natural-person holder, which on a pre-IPO cap table
  // overwhelmingly means founder / early common holder. Without this
  // S-1 rows that omit a Class column collapse to "unknown".
  const words = name.trim().split(/\s+/);
  if (words.length >= 2 && words.length <= 4 && !/\d/.test(name)) {
    return "founder";
  }
  return "unknown";
}
