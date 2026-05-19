// Task #13: PII redaction pre-pass.
//
// Default-on regex-based scrubber for the high-risk identifiers
// (emails, SSNs, ITINs, US bank account numbers, IBAN, phone numbers,
// credit cards). Each match is replaced with a placeholder of the
// same kind so the redacted text still flows naturally through an
// LLM prompt. A counts map is returned alongside so the caller can
// log how much was scrubbed.
//
// Per-document override: documents.allow_raw_text = 1 bypasses
// redaction (audit-logged in routes/documents.ts).

export interface RedactionCounts {
  email: number;
  ssn: number;
  itin: number;
  us_bank_account: number;
  iban: number;
  phone: number;
  credit_card: number;
}

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
  total: number;
}

const EMAIL_RE      = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// SSN: 3-2-4 with separators; rejects all-zero groups + 666 area + 9xx area.
const SSN_RE        = /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g;
// ITIN: 9 + [70-88, 90-92, 94-99] + 4
const ITIN_RE       = /\b9\d{2}[-\s]?(7\d|8[0-8]|9[0-24-9])[-\s]?\d{4}\b/g;
// US bank account: routing 9 digits, account 6-17 digits, when seen near "account" or "routing"
const US_BANK_RE    = /\b(?:routing|aba|account|acct|a\/c)[#:\s]*\d{6,17}\b/gi;
// IBAN: 2 letters + 2 digits + 11-30 alphanum
const IBAN_RE       = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// Phone: US-style + intl with +
const PHONE_RE      = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
// Credit card: 13-19 digits, allow spaces/dashes; Luhn-checked post-match.
const CC_RE         = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(s: string): boolean {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactPii(input: string): RedactionResult {
  const counts: RedactionCounts = {
    email: 0, ssn: 0, itin: 0, us_bank_account: 0,
    iban: 0, phone: 0, credit_card: 0,
  };
  let text = input;
  text = text.replace(EMAIL_RE, () => { counts.email++; return "[REDACTED_EMAIL]"; });
  text = text.replace(SSN_RE,   () => { counts.ssn++;   return "[REDACTED_SSN]"; });
  text = text.replace(ITIN_RE,  () => { counts.itin++;  return "[REDACTED_ITIN]"; });
  text = text.replace(US_BANK_RE, () => { counts.us_bank_account++; return "[REDACTED_BANK_ACCOUNT]"; });
  text = text.replace(IBAN_RE,  () => { counts.iban++;  return "[REDACTED_IBAN]"; });
  // Credit card: Luhn-checked so we don't scrub long ID numbers.
  text = text.replace(CC_RE, (m) => {
    if (luhnValid(m)) { counts.credit_card++; return "[REDACTED_CC]"; }
    return m;
  });
  // Phone last so we don't eat digits from already-redacted runs.
  text = text.replace(PHONE_RE, () => { counts.phone++; return "[REDACTED_PHONE]"; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text, counts, total };
}

/** Convenience: returns the (possibly redacted) text based on allow_raw_text. */
export function prepareForLlm(input: string, allowRaw: boolean): RedactionResult {
  if (allowRaw) {
    return {
      text: input,
      counts: { email: 0, ssn: 0, itin: 0, us_bank_account: 0, iban: 0, phone: 0, credit_card: 0 },
      total: 0,
    };
  }
  return redactPii(input);
}
