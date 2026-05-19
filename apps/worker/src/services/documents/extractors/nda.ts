// Task #13: NDA extractor.
//
// Identifies term, scope (mutual vs unilateral), governing law, and
// flags unusual clauses (non-solicit, non-compete, IP assignment, etc.)
// which a reviewer should look at before signing.

export const NDA_EXTRACTOR_VERSION = "1.0.0";

export interface NdaExtraction {
  is_mutual: boolean;
  term_months: number | null;
  governing_law: string | null;
  unusual_clause_flags: string[];     // e.g. ["non_solicit", "non_compete", "ip_assignment"]
  warnings: string[];
}

const UNUSUAL: Array<[string, RegExp]> = [
  ["non_solicit", /non[-\s]?solicit/i],
  ["non_compete", /non[-\s]?compete/i],
  ["ip_assignment", /(assignment\s+of\s+(?:all\s+)?intellectual\s+property|ip\s+assignment)/i],
  ["residuals_clause", /residual(?:s)?\s+clause/i],
  ["perpetual_term", /\bperpetual(?:ly)?\b/i],
  ["liquidated_damages", /liquidated\s+damages/i],
  ["broad_definition", /any\s+information\s+(?:disclosed|provided)/i],
];

export function extractNda(text: string): NdaExtraction {
  const warnings: string[] = [];
  const is_mutual = /(mutual\s+(?:non[-\s]?disclosure|nda)|each\s+party\s+(?:shall\s+)?(?:protect|treat))/i.test(text);

  const termM = /(?:term\s+of\s+(?:this\s+)?agreement|confidentiality\s+obligations?\s+shall\s+(?:survive|last))[^\d]{0,80}(\d{1,3})\s*(month|year)s?/i.exec(text);
  const term_months = termM ? (termM[2].toLowerCase() === "year" ? Number(termM[1]) * 12 : Number(termM[1])) : null;

  const lawM = /governed\s+by\s+the\s+laws?\s+of(?:\s+the\s+state\s+of)?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/i.exec(text);
  const governing_law = lawM ? lawM[1].trim() : null;

  const unusual_clause_flags: string[] = [];
  for (const [name, re] of UNUSUAL) if (re.test(text)) unusual_clause_flags.push(name);

  if (term_months == null) warnings.push("no_term_found");
  return { is_mutual, term_months, governing_law, unusual_clause_flags, warnings };
}
