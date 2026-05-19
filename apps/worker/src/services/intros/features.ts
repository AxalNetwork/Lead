// Pure feature extractor for the intro-routing logistic model.
// No DB access — accepts a path + pre-fetched context (target's
// PageRank, broker scores for path nodes, target's conversation hooks).
// Returns the 5-dim feature vector documented in the Task #4 spec.

import type { PFPath } from "./pathfinder";

export interface FeatureContext {
  /** entity_influence.pagerank_score for the target, [0,1] */
  target_pagerank: number | null;
  /** {entity_id → broker_score} for every node on the path */
  broker_scores: Record<string, number | null>;
  /** target's recent hook_text strings — used for ask-context similarity */
  target_hooks: string[];
}

export interface IntroFeatures {
  /** number of hops (1..3) */
  path_length: number;
  /** weakest edge quality_score along path; 0 when entirely unscored */
  weakest_eq: number;
  /** target PageRank in [0,1]; 0 when unknown */
  target_pr: number;
  /** 1 if any intermediate node has broker_score >= 0.6, else 0 */
  broker_in_path: number;
  /** cosine-ish overlap between ask_context tokens and target hook tokens, [0,1] */
  ask_match: number;
}

export function extractFeatures(
  path: PFPath,
  askContext: string,
  ctx: FeatureContext,
): IntroFeatures {
  const path_length = path.hops.length;
  const weakest_eq = clamp01(typeof path.weakest_edge_quality === "number" ? path.weakest_edge_quality : 0);
  const target_pr = clamp01(typeof ctx.target_pagerank === "number" ? ctx.target_pagerank : 0);

  // Broker presence: any *intermediate* node (excluding endpoints) with
  // broker_score >= 0.6. For 1-hop paths there are no intermediates ⇒ 0.
  let broker_in_path = 0;
  if (path.nodes.length > 2) {
    const intermediates = path.nodes.slice(1, -1);
    for (const n of intermediates) {
      const b = ctx.broker_scores[n];
      if (typeof b === "number" && b >= 0.6) { broker_in_path = 1; break; }
    }
  }

  const ask_match = cosineTokenOverlap(askContext, ctx.target_hooks.join(" "));

  return { path_length, weakest_eq, target_pr, broker_in_path, ask_match };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Tokenize on word boundaries, lowercase, drop very short tokens + a small stop list. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "for", "in", "on", "at", "by",
  "is", "are", "was", "were", "be", "been", "being", "with", "as", "from", "that",
  "this", "it", "its", "our", "their", "his", "her", "your", "we", "you", "they",
  "i", "me", "my", "us", "into", "about", "than",
]);

export function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Cosine on bag-of-tokens (binary vectors). Returns [0,1]. */
export function cosineTokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const denom = Math.sqrt(ta.size * tb.size);
  if (denom === 0) return 0;
  return Math.min(1, inter / denom);
}
