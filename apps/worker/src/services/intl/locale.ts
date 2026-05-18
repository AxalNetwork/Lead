// Task #3: Locale normalization.
//
// Date and address parsing for international filings. Pure, deps-free,
// deterministic. Adapters never roll their own date/address parse — they
// call into here.
//
// Date formats covered:
//   * ISO        YYYY-MM-DD
//   * UK / EU    DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, "1 Jan 2024"
//   * US         MM/DD/YYYY        (only when localeHint = "US")
//   * CJK        2024年1月15日, 2024年01月15日
//   * Hebrew     15.1.2024         (Israeli convention is DD.MM.YYYY)
//
// We pick a single locale hint per adapter so we never have to guess
// between UK and US ambiguous "01/02/2024" (Jan 2 or Feb 1) — that
// ambiguity is the #1 source of subtly-wrong dates.

import type { JurisdictionCode } from "../../crawler/adapters/intl/types";

/** Per-jurisdiction date parsing locale. Most of the world is DD/MM/YYYY;
 *  the US is the outlier. Adapters pass their jurisdiction; the engine
 *  never mixes them up. */
const DATE_LOCALE: Record<JurisdictionCode, "EU" | "US" | "ISO" | "CJK" | "IL"> = {
  UK: "EU", EU: "EU", DE: "EU", FR: "EU", NL: "EU", SE: "ISO", ES: "EU",
  IT: "EU", IE: "EU", SG: "EU", IL: "IL", IN: "EU", CN: "CJK", HK: "EU",
  CA: "ISO", AU: "EU", BR: "EU",
};

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }
function isYear(n: number): boolean { return n >= 1900 && n <= 2100; }

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  // German short forms used by BaFin filings.
  mär: 3, mae: 3, mrz: 3, okt: 10, dez: 12,
  // French
  janv: 1, févr: 2, fevr: 2, mars: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, août: 8, aout: 8, sept2: 9, oct2: 10, déc: 12, dec2: 12,
};

/** Parse a raw date string in the adapter's jurisdiction locale.
 *  Returns ISO YYYY-MM-DD on success, null on parse failure.
 *
 *  We intentionally REFUSE to guess on ambiguous input (e.g. "01/02"
 *  with no year, or a US-style date when the locale is EU). Returning
 *  null forces the adapter to record a parse_confidence < 1. */
export function parseDate(raw: string | null | undefined, jurisdiction: JurisdictionCode): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO short-circuit — accept regardless of locale.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isYear(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }

  const locale = DATE_LOCALE[jurisdiction];

  // CJK: YYYY年M月D日
  m = /^(\d{4})年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;

  // Word-month: "1 Jan 2024" / "January 1, 2024" / "1. Januar 2024"
  m = /^(\d{1,2})[.\s-]+([A-Za-zÀ-ÿ]+)[.,\s-]+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().replace(/\.$/, "")];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(+m[1])}`;
  }
  m = /^([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().replace(/\.$/, "")];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(+m[2])}`;
  }

  // Numeric DD/MM/YYYY (EU / IL) — also accepts . or -
  if (locale === "EU" || locale === "IL" || locale === "ISO") {
    m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
    if (m) {
      let y = +m[3]; if (y < 100) y += y < 50 ? 2000 : 1900;
      const d = +m[1], mo = +m[2];
      if (isYear(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return `${y}-${pad(mo)}-${pad(d)}`;
      }
    }
  }
  // US — MM/DD/YYYY
  if (locale === "US") {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
    if (m) {
      let y = +m[3]; if (y < 100) y += y < 50 ? 2000 : 1900;
      const mo = +m[1], d = +m[2];
      if (isYear(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return `${y}-${pad(mo)}-${pad(d)}`;
      }
    }
  }
  return null;
}

export interface ParsedAddress {
  country_iso2: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  street: string | null;
  /** 0..1; <1 when at least one field was guessed or missing. */
  parse_confidence: number;
  original: string;
}

/** Postal-code shape per country. Used as a tie-breaker to find the
 *  country when the address line doesn't end with an ISO/name token. */
const POSTAL_RE: Partial<Record<JurisdictionCode, RegExp>> = {
  UK: /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i,    // SW1A 1AA
  DE: /\b(\d{5})\b/,
  FR: /\b(\d{5})\b/,
  NL: /\b(\d{4}\s?[A-Z]{2})\b/,
  SE: /\b(\d{3}\s?\d{2})\b/,
  ES: /\b(\d{5})\b/,
  IT: /\b(\d{5})\b/,
  IE: /\b([A-Z]\d{2}\s?[A-Z\d]{4})\b/i,             // Eircode
  SG: /\b(\d{6})\b/,
  IL: /\b(\d{5,7})\b/,
  IN: /\b(\d{6})\b/,
  CN: /\b(\d{6})\b/,
  HK: /(?:)/,                                        // no postal codes
  CA: /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i,
  AU: /\b(\d{4})\b/,
  BR: /\b(\d{5}-?\d{3})\b/,
};

/** Parse a free-form single-line address for the given jurisdiction.
 *  Always returns a row — `parse_confidence` reflects how much we
 *  recovered. The original string is preserved for replay. */
export function parseAddress(raw: string | null | undefined, jurisdiction: JurisdictionCode): ParsedAddress {
  const original = (raw ?? "").trim();
  if (!original) {
    return { country_iso2: null, region: null, city: null, postal_code: null, street: null, parse_confidence: 0, original: "" };
  }
  const country_iso2 = jurisdiction === "EU" ? null : jurisdiction;
  const postal = POSTAL_RE[jurisdiction]?.exec(original)?.[1]?.toUpperCase().replace(/\s+/g, "") ?? null;
  // City heuristic: token immediately after the postal code.
  let city: string | null = null;
  if (postal) {
    const idx = original.toUpperCase().indexOf(postal.replace(/\s+/g, ""));
    if (idx >= 0) {
      const after = original.slice(idx + postal.length).replace(/^[,\s-]+/, "");
      city = after.split(/[,;]/)[0]?.trim() || null;
    }
  } else {
    // Fallback: last comma-segment that isn't a country name.
    const parts = original.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    city = parts[parts.length - 2] ?? parts[parts.length - 1] ?? null;
  }
  // Street heuristic: everything up to the first postal/city anchor.
  let street: string | null = null;
  if (postal) {
    const head = original.split(postal)[0];
    street = head?.replace(/[,\s]+$/, "").trim() || null;
  } else {
    const parts = original.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    street = parts[0] ?? null;
  }
  const recovered = [country_iso2, city, postal, street].filter(Boolean).length;
  const parse_confidence = Math.min(1, recovered / 4);
  return { country_iso2, region: null, city, postal_code: postal, street, parse_confidence, original };
}
