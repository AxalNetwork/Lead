// Cell-level type coercers used by import.ts after the user confirms a
// column map. Every coercer is null-safe and idempotent — passing already-
// coerced values through returns the same value.

import type { Env } from "../types";
import { flagToIso2, flagsToIso2List, stripFlags } from "./flag_emoji";
import { COUNTRY_NAME_TO_ISO2 } from "./country_iso2";

// ---- money ---------------------------------------------------------------

const MONEY_RE = /([€£¥$]|US\$|USD|EUR|GBP|JPY|CAD|AUD|CHF|HKD|SGD|INR|CNY|RMB|KRW|BRL|MXN)?\s*([\d.,'\u00a0\u202f\u2009 ]+)\s*(k|m|mm|mn|b|bn|t|tn|trillion|billion|million|thousand|k\+|m\+|b\+)?/i;

const CURRENCY_SYMBOL: Record<string, string> = {
  "$": "USD", "US$": "USD", "USD": "USD",
  "€": "EUR", "EUR": "EUR",
  "£": "GBP", "GBP": "GBP",
  "¥": "JPY", "JPY": "JPY",
  "CAD": "CAD", "AUD": "AUD", "CHF": "CHF", "HKD": "HKD",
  "SGD": "SGD", "INR": "INR", "CNY": "CNY", "RMB": "CNY",
  "KRW": "KRW", "BRL": "BRL", "MXN": "MXN",
};

const SCALE_MULT: Record<string, number> = {
  k: 1e3, "k+": 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, "m+": 1e6, million: 1e6,
  b: 1e9, bn: 1e9, "b+": 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

export interface MoneyParse {
  /** USD value (after FX), rounded to nearest cent. */
  usd: number | null;
  /** Original currency code or null if unknown. */
  currency: string | null;
  /** Numeric value in the original currency. */
  native: number | null;
  /** "M", "B", etc., normalized to lowercase or null. */
  scale: string | null;
}

/** Parse "$1.2M", "€500K", "1,200,000 USD", "USD 2.5bn". Returns nulls on failure. */
export function parseMoney(raw: string | null | undefined): MoneyParse {
  const empty: MoneyParse = { usd: null, currency: null, native: null, scale: null };
  if (raw == null) return empty;
  const s = String(raw).trim();
  if (!s || /^(n\/?a|tbd|undisclosed|unknown|—|-)$/i.test(s)) return empty;
  const m = MONEY_RE.exec(s);
  if (!m) return empty;
  const sym = (m[1] || "").trim();
  const numRaw = (m[2] || "").trim();
  const scale = (m[3] || "").trim().toLowerCase();
  // Normalize 1,200.50 / 1.200,50 / 1 200,50.
  const num = normalizeNumber(numRaw);
  if (num == null) return empty;
  const mult = SCALE_MULT[scale] ?? 1;
  const native = num * mult;
  const currency = CURRENCY_SYMBOL[sym] ?? CURRENCY_SYMBOL[sym.toUpperCase()] ?? null;
  return { usd: null, currency, native: Math.round(native * 100) / 100, scale: scale || null };
}

export interface MoneyRange {
  currency: string | null;
  min: number | null;          // native min
  max: number | null;          // native max
  typical_native: number | null;
  typical_usd: number | null;
}

/** Parse a money range like "50-100M EUR", "$1M – $5M", "€500K to €2M".
 *  When the input is a single value, min=max=typical=that value. */
export function parseMoneyRange(raw: string | null | undefined): MoneyRange {
  const empty: MoneyRange = { currency: null, min: null, max: null, typical_native: null, typical_usd: null };
  if (raw == null) return empty;
  const s = String(raw).trim();
  if (!s || /^(n\/?a|tbd|undisclosed|unknown|—|-)$/i.test(s)) return empty;
  // Split on common range separators while keeping the surrounding context
  // for currency / scale inference (e.g. "50-100M EUR" → ["50", "100M EUR"]).
  const parts = s.split(/\s*(?:-|–|—|to|through|\.\.|—|→)\s*/i);
  if (parts.length === 2) {
    // Inherit currency/scale from whichever side has it.
    const right = parseMoney(parts[1]);
    const leftRaw = parts[0].trim();
    // If the left side has no scale/currency, glue them on from the right.
    const leftHydrated = /[a-z€£¥$]/i.test(leftRaw)
      ? leftRaw
      : `${leftRaw}${right.scale ?? ""} ${right.currency ?? ""}`.trim();
    const left = parseMoney(leftHydrated);
    if (left.native != null && right.native != null) {
      const typ = (left.native + right.native) / 2;
      return {
        currency: right.currency ?? left.currency,
        min: Math.min(left.native, right.native),
        max: Math.max(left.native, right.native),
        typical_native: Math.round(typ * 100) / 100,
        typical_usd: null,
      };
    }
  }
  const single = parseMoney(s);
  if (single.native == null) return empty;
  return {
    currency: single.currency,
    min: single.native, max: single.native,
    typical_native: single.native, typical_usd: null,
  };
}

/** Range version with FX cache → fills typical_usd. */
export async function parseMoneyRangeUsd(env: Env, raw: string | null | undefined): Promise<MoneyRange> {
  const r = parseMoneyRange(raw);
  if (r.typical_native == null) return r;
  if (!r.currency || r.currency === "USD") return { ...r, typical_usd: r.typical_native };
  const rate = await fxToUsd(env, r.currency);
  if (rate == null) return r;
  return { ...r, typical_usd: Math.round(r.typical_native * rate * 100) / 100 };
}

/** Same as parseMoney but applies an FX cache to fill `usd`. */
export async function parseMoneyUsd(env: Env, raw: string | null | undefined): Promise<MoneyParse> {
  const m = parseMoney(raw);
  if (m.native == null) return m;
  if (!m.currency || m.currency === "USD") return { ...m, usd: m.native };
  const rate = await fxToUsd(env, m.currency);
  if (rate == null) return m;
  return { ...m, usd: Math.round(m.native * rate * 100) / 100 };
}

/** Detect "1,200.50" (US) vs "1.200,50" (EU) vs "1 200,50" (FR). */
function normalizeNumber(s: string): number | null {
  let v = s.replace(/[\u00a0\u202f\u2009 ']/g, "");
  const lastComma = v.lastIndexOf(",");
  const lastDot = v.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) { v = v.replace(/\./g, "").replace(",", "."); }
    else { v = v.replace(/,/g, ""); }
  } else if (lastComma > -1 && lastDot === -1) {
    // Lone comma: if 3 digits after, it's a thousands sep ("1,200"); else decimal.
    const after = v.length - lastComma - 1;
    v = after === 3 && !/^,/.test(v) ? v.replace(/,/g, "") : v.replace(",", ".");
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ---- FX cache (24h KV) ---------------------------------------------------

const FX_CACHE_PREFIX = "fx:usd:";
const FX_TTL = 60 * 60 * 24;

/** Returns USD-per-1-unit-of-`code`. Null on miss. */
export async function fxToUsd(env: Env, code: string): Promise<number | null> {
  const c = code.toUpperCase();
  if (c === "USD") return 1;
  const kv = env.SCRAPE_CACHE;
  if (kv) {
    try {
      const cached = await kv.get(`${FX_CACHE_PREFIX}${c}`);
      if (cached) {
        const n = parseFloat(cached);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch { /* ignore */ }
  }
  // Free, no-key public endpoint. Hard timeout via AbortSignal (CI gate).
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(c)}`, {
      signal: ctl.signal, headers: { "User-Agent": "AIDataSignalBot/1.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json() as { rates?: Record<string, number> };
    const usd = j?.rates?.USD;
    if (typeof usd !== "number" || !(usd > 0)) return null;
    if (kv) await kv.put(`${FX_CACHE_PREFIX}${c}`, String(usd), { expirationTtl: FX_TTL });
    return usd;
  } catch { return null; }
}

// ---- year ---------------------------------------------------------------

/** Return a 4-digit year in [1900, currentYear+2] or null. Accepts "FY24",
 *  "'24", "2024", "2024-03", date strings, or floats from spreadsheet exports. */
export function parseYear(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /\b((?:19|20)\d{2})\b/.exec(s);
  if (m) return clampYear(parseInt(m[1], 10));
  const fy = /\bFY\s*['"]?(\d{2})\b/i.exec(s);
  if (fy) return clampYear(2000 + parseInt(fy[1], 10));
  const apos = /^['']?(\d{2})$/.exec(s);
  if (apos) return clampYear(2000 + parseInt(apos[1], 10));
  return null;
}

function clampYear(y: number): number | null {
  const now = new Date().getUTCFullYear();
  return y >= 1900 && y <= now + 2 ? y : null;
}

// ---- stage --------------------------------------------------------------

const STAGE_ALIASES: Array<{ canon: string; re: RegExp }> = [
  { canon: "pre-seed", re: /\b(pre[\s-]?seed|preseed)\b/i },
  { canon: "seed", re: /\bseed\b/i },
  { canon: "series-a", re: /\b(series\s*a|series-a|\ba\s*round\b)\b/i },
  { canon: "series-b", re: /\b(series\s*b|series-b|\bb\s*round\b)\b/i },
  { canon: "series-c", re: /\b(series\s*c|series-c|\bc\s*round\b)\b/i },
  { canon: "series-d", re: /\b(series\s*d|series-d|\bd\s*round\b)\b/i },
  { canon: "series-e+", re: /\b(series\s*[ef-z]|growth|late[\s-]?stage|pre[\s-]?ipo)\b/i },
  { canon: "venture", re: /\bventure\b/i },
  { canon: "growth", re: /\b(growth\s*equity|expansion)\b/i },
  { canon: "buyout", re: /\b(buy[\s-]?out|lbo|mbo|leveraged)\b/i },
  { canon: "secondary", re: /\bsecondar(y|ies)\b/i },
  { canon: "debt", re: /\b(debt|venture\s*debt|credit)\b/i },
  { canon: "grant", re: /\b(grant|non[\s-]?dilutive|award)\b/i },
];

/** Split "Seed, Series A, B" into ["seed","series-a","series-b"]. */
export function parseStages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = String(raw).split(/[,;|/&]+|\s+(?:and|&|\+|to|through|-)\s+/i);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim(); if (!t) continue;
    for (const a of STAGE_ALIASES) {
      if (a.re.test(t) && !seen.has(a.canon)) { seen.add(a.canon); out.push(a.canon); break; }
    }
  }
  return out;
}

// ---- country / iso2 -----------------------------------------------------

/** Resolve a cell to an ISO-3166-1 alpha-2 code. Tries (in order):
 *  flag emoji, raw ISO2, name lookup. Returns null on miss. */
export function parseCountryIso2(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const flag = flagToIso2(s);
  if (flag) return flag;
  const stripped = stripFlags(s);
  // Bare ISO2 (case-insensitive, must be exactly two letters).
  if (/^[a-z]{2}$/i.test(stripped)) return stripped.toUpperCase();
  // Name lookup; use lowercase normalization.
  const key = stripped.toLowerCase().replace(/\bthe\b\s+/g, "").replace(/[^a-z]+/g, " ").trim();
  return COUNTRY_NAME_TO_ISO2[key] ?? null;
}

/** Multi-country cell ("🇫🇷, 🇩🇪, France & Germany") → unique ISO2 list. */
export function parseCountryIso2List(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const flags = flagsToIso2List(raw);
  if (flags.length) return flags;
  const stripped = stripFlags(String(raw));
  const parts = stripped.split(/[,;|/&]+|\s+(?:and|&|\+)\s+/i);
  const out: string[] = []; const seen = new Set<string>();
  for (const p of parts) {
    const iso = parseCountryIso2(p);
    if (iso && !seen.has(iso)) { seen.add(iso); out.push(iso); }
  }
  return out;
}

// ---- url ----------------------------------------------------------------

/** Normalize cell to https URL (lift bare domains, strip wrapping text).
 *  Returns null if no plausible URL. */
export function parseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /https?:\/\/[^\s"'<>)\]]+/i.exec(s);
  if (m) return m[0].replace(/[.,;:]+$/, "");
  // Bare host: "acme.vc", "example.com/path".
  const bare = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+(\/[\S]*)?$/i;
  if (bare.test(s)) return `https://${s.replace(/^\/\//, "")}`;
  return null;
}

// ---- boolean ------------------------------------------------------------

export function parseBool(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|t|1|✓|✅|x)$/.test(s)) return true;
  if (/^(n|no|false|f|0|—|-|✗|❌)$/.test(s)) return false;
  return null;
}

// ---- empty / placeholder ------------------------------------------------

const EMPTY_RE = /^(|n\/?a|none|null|nil|—|-|tbd|undisclosed|unknown|\?+)$/i;

export function isEmptyCell(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  return EMPTY_RE.test(String(raw).trim());
}
