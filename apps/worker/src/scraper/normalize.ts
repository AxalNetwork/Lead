// Normalization helpers used by the parsers and dedupe key generators.

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const PHONE_DIGITS_RE = /[^\d+]/g;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(s)) return null;
  return s;
}

/**
 * Email key for dedupe purposes only — strips +tags and lowercases the domain.
 * The displayed email uses normalizeEmail (preserves the +tag).
 */
export function emailDedupeKey(email: string): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const [localPart, domain] = e.split("@");
  const stripped = localPart.split("+")[0];
  return `${stripped}@${domain.toLowerCase()}`;
}

/**
 * Best-effort E.164 normalization. We only accept numbers that already include
 * a leading + or are clearly internationalizable (10–15 digits). Otherwise null.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(PHONE_DIGITS_RE, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1);
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }
  // No country code → don't guess; return null so we don't pollute dedupe keys.
  if (cleaned.length === 10 || cleaned.length === 11) {
    // Common case: US/Canada 10 digits or 1+10 digits.
    const d = cleaned.length === 10 ? `1${cleaned}` : cleaned;
    return `+${d}`;
  }
  return null;
}

export function canonicalizeLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.endsWith("linkedin.com")) return null;
    // Trailing slash and query strip
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    if (!/^\/(in|company|school)\/[^\/]+/.test(path)) return null;
    return `https://www.linkedin.com${path}`;
  } catch {
    return null;
  }
}

export function countryNameToIso2(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name.trim().toLowerCase();
  // Tiny seed map; the full mapping lives with the taxonomies task.
  const seed: Record<string, string> = {
    usa: "US",
    "united states": "US",
    "united states of america": "US",
    canada: "CA",
    uk: "GB",
    "united kingdom": "GB",
    england: "GB",
    france: "FR",
    germany: "DE",
    spain: "ES",
    italy: "IT",
    netherlands: "NL",
    switzerland: "CH",
    israel: "IL",
    india: "IN",
    china: "CN",
    japan: "JP",
    singapore: "SG",
    australia: "AU",
    brazil: "BR",
  };
  if (s.length === 2) return s.toUpperCase();
  return seed[s] ?? null;
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
