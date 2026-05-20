// Task #8: hallucination verifier. Pure module — no DB / no env.
//
// Two checks per (claim_text, source_span, source_text):
//   1. source_span must be non-empty AND occur in normalized source_text.
//   2. normalized source_span must either CONTAIN the claim's key tokens
//      OR fuzzy-match them at >= 0.7 (token Jaccard).
//
// Returns either {ok:true} (caller proceeds to insertFact) or
// {ok:false, reason, fuzzy_score?} (caller writes hallucination_flags
// and SKIPS insertFact). The verifier never deletes or mutates rows.

export type VerifyFailReason =
  | "empty_span"
  | "span_not_in_source"
  | "claim_not_in_span"
  | "low_fuzzy";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailReason;
  fuzzy_score?: number;
}

export interface VerifyInput {
  claim_text: string;
  source_span: string | null | undefined;
  source_text: string;
  fuzzyThreshold?: number;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "by",
  "with", "is", "was", "are", "were", "be", "been", "being", "at",
  "from", "as", "it", "its", "this", "that", "these", "those", "their",
]);

export function keyTokens(s: string): string[] {
  return normalize(s).split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function verifySourceSpan(input: VerifyInput): VerifyResult {
  const threshold = input.fuzzyThreshold ?? 0.7;
  const span = (input.source_span ?? "").trim();
  if (!span) return { ok: false, reason: "empty_span" };
  const nSpan = normalize(span);
  const nSource = normalize(input.source_text);
  if (!nSource.includes(nSpan)) {
    // Span isn't a literal substring of the source. Allow a tolerant
    // token-overlap fallback so paraphrased / re-wrapped HTML doesn't
    // immediately fail — but only at the strict 0.85 threshold to
    // separate "valid reflow" from "made up".
    const spanTokens = keyTokens(span);
    const sourceTokens = keyTokens(input.source_text);
    const present = spanTokens.filter((t) => sourceTokens.includes(t)).length;
    const ratio = spanTokens.length === 0 ? 0 : present / spanTokens.length;
    if (ratio < 0.85) return { ok: false, reason: "span_not_in_source", fuzzy_score: ratio };
  }
  const claimTokens = keyTokens(input.claim_text);
  if (claimTokens.length === 0) {
    // Claim is all stopwords (empty / "the" / etc). With no signal to
    // verify, fail closed.
    return { ok: false, reason: "claim_not_in_span", fuzzy_score: 0 };
  }
  const spanTokens = keyTokens(span);
  const contains = claimTokens.every((t) => spanTokens.includes(t));
  if (contains) return { ok: true };
  const score = jaccard(claimTokens, spanTokens);
  if (score >= threshold) return { ok: true, fuzzy_score: score };
  return { ok: false, reason: "low_fuzzy", fuzzy_score: score };
}
