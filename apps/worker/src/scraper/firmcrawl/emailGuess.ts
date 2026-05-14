// Generate the four canonical email-pattern guesses for a person at a firm.
// Stored with verified=0, source='pattern_guess'. Outbound paths must never
// use unverified guesses — Hunter.io verification (Task 6) flips verified=1.

export interface EmailGuess {
  email: string;
  pattern: "first.last" | "first" | "flast" | "firstlast";
  verified: 0;
  source: "pattern_guess";
}

function clean(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")
    .trim();
}

function splitName(fullName: string): { first: string; last: string } | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: clean(parts[0]), last: clean(parts[parts.length - 1]) };
}

function normDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const dom = d.toLowerCase().replace(/^www\./, "").trim();
  if (!/^[a-z0-9.\-]+\.[a-z]{2,}$/.test(dom)) return null;
  return dom;
}

/**
 * Returns up to 4 pattern guesses. Empty when name or domain is unusable.
 */
export function guessEmails(fullName: string | null | undefined, domain: string | null | undefined): EmailGuess[] {
  if (!fullName) return [];
  const split = splitName(fullName);
  if (!split) return [];
  const { first, last } = split;
  if (!first || !last) return [];
  const dom = normDomain(domain);
  if (!dom) return [];
  const out: EmailGuess[] = [
    { email: `${first}.${last}@${dom}`, pattern: "first.last", verified: 0, source: "pattern_guess" },
    { email: `${first}@${dom}`,         pattern: "first",      verified: 0, source: "pattern_guess" },
    { email: `${first[0]}${last}@${dom}`, pattern: "flast",    verified: 0, source: "pattern_guess" },
    { email: `${first}${last}@${dom}`,  pattern: "firstlast",  verified: 0, source: "pattern_guess" },
  ];
  // Dedupe (e.g. single-letter first names collapse first/flast).
  const seen = new Set<string>();
  return out.filter((g) => (seen.has(g.email) ? false : (seen.add(g.email), true)));
}
