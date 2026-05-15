// Decode 🇺🇸-style flag emojis to ISO-3166-1 alpha-2 codes. A flag emoji is
// the pair of Regional Indicator Symbol Letters (U+1F1E6..U+1F1FF) for the
// two letters of the country code; subtract 0x1F1E6 and add 'A'.

const RI_BASE = 0x1f1e6;
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** Return the first ISO2 found in `s`, or null. */
export function flagToIso2(s: string | null | undefined): string | null {
  if (!s) return null;
  FLAG_RE.lastIndex = 0;
  const m = FLAG_RE.exec(String(s));
  if (!m) return null;
  return riPairToIso2(m[0]);
}

/** Return ALL ISO2 codes embedded in `s` (for "🇫🇷 🇩🇪 🇪🇸" multi-flag cells). */
export function flagsToIso2List(s: string | null | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  FLAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLAG_RE.exec(String(s))) !== null) {
    const iso = riPairToIso2(m[0]);
    if (iso && !seen.has(iso)) { seen.add(iso); out.push(iso); }
  }
  return out;
}

function riPairToIso2(pair: string): string | null {
  // String iteration yields full code points for surrogate-pair RI letters.
  const cps: number[] = [];
  for (const ch of pair) {
    const cp = ch.codePointAt(0);
    if (cp == null) return null;
    cps.push(cp);
  }
  if (cps.length !== 2) return null;
  const a = cps[0] - RI_BASE;
  const b = cps[1] - RI_BASE;
  if (a < 0 || a > 25 || b < 0 || b > 25) return null;
  return String.fromCharCode(65 + a, 65 + b);
}

/** Strip flag emojis (and trailing whitespace) from `s`. */
export function stripFlags(s: string): string {
  return s.replace(FLAG_RE, " ").replace(/\s+/g, " ").trim();
}
