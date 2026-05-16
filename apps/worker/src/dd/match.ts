// Task #3: name-matching engine for DD watchlist hits.
//
// Three deterministic signals (exact, phonetic, fuzzy) plus an optional
// AI arbitration tier when the deterministic composite lands in the
// 0.55..0.85 "ambiguous" zone. Caller passes one candidate name + any
// number of aliases; we return the best composite score.

import type { Env } from "../types";
import { aiArbitrate } from "../ai/extract";

export interface MatchEvidence {
  exact: number;        // 1 if any normalized form matched, else 0
  phonetic: number;     // 0..1 via Metaphone equality on tokens
  fuzzy: number;        // 0..1 token Jaccard + Levenshtein
  ai?: number;          // 0..1 from aiArbitrate if invoked
  best_alias?: string;
  best_method: "exact" | "phonetic" | "fuzzy" | "ai_arbitrated";
}

export interface MatchResult {
  score: number;        // 0..1 composite
  method: MatchEvidence["best_method"];
  evidence: MatchEvidence;
}

// ---- Normalisation ----

const HONORIFICS = new Set([
  "mr","mrs","ms","mx","dr","prof","sir","dame","lord","lady",
  "hon","hh","mme","mlle","srta","sra","sr",
]);
const SUFFIXES = new Set(["jr","sr","ii","iii","iv","phd","md","esq"]);

export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(name: string): string[] {
  return normalizeName(name)
    .split(/[\s'-]+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t) && !SUFFIXES.has(t));
}

// ---- Metaphone (simplified — good enough for English-Latin scripts) ----

export function metaphone(input: string): string {
  let s = input.toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  s = s
    .replace(/^KN|^GN|^PN|^AE|^WR/, (m) => m[1])
    .replace(/^X/, "S")
    .replace(/^WH/, "W");
  s = s
    .replace(/MB$/, "M")
    .replace(/SCH/g, "SK")
    .replace(/TH/g, "0")
    .replace(/CH/g, "X")
    .replace(/SH/g, "X")
    .replace(/PH/g, "F")
    .replace(/CK/g, "K")
    .replace(/Q/g, "K")
    .replace(/X/g, "KS")
    .replace(/[WY](?![AEIOU])/g, "")
    .replace(/Z/g, "S")
    .replace(/V/g, "F")
    .replace(/(.)\1+/g, "$1");
  // drop interior vowels
  s = s[0] + s.slice(1).replace(/[AEIOU]/g, "");
  return s.slice(0, 6);
}

// ---- Levenshtein (capped — return 1.0 if equal length within cap) ----

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function levSim(a: string, b: string): number {
  const L = Math.max(a.length, b.length);
  if (!L) return 1;
  return 1 - levenshtein(a, b) / L;
}

// ---- Signals ----

function exactScore(a: string, b: string): number {
  return normalizeName(a) === normalizeName(b) ? 1 : 0;
}

function phoneticScore(a: string, b: string): number {
  const ta = tokenize(a).map(metaphone).filter(Boolean);
  const tb = tokenize(b).map(metaphone).filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const hits = ta.filter((t) => setB.has(t)).length;
  return hits / Math.max(ta.length, tb.length);
}

function fuzzyScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  // Token-level Jaccard over the best-pair Lev similarity.
  let sum = 0, n = 0;
  for (const x of ta) {
    let best = 0;
    for (const y of tb) {
      const s = levSim(x, y);
      if (s > best) best = s;
    }
    sum += best;
    n += 1;
  }
  const fwd = sum / n;
  // Symmetric
  let sum2 = 0;
  for (const y of tb) {
    let best = 0;
    for (const x of ta) {
      const s = levSim(x, y);
      if (s > best) best = s;
    }
    sum2 += best;
  }
  const bwd = sum2 / tb.length;
  return (fwd + bwd) / 2;
}

// ---- Public ----

export interface MatchOptions {
  enableAi?: boolean;
  aiContextA?: string;       // optional extra bio/role text for AI arbiter
  aiContextB?: string;
}

/**
 * Compare a candidate name (with optional aliases) to a watchlist
 * record name (with optional aliases). Returns the best composite
 * match score across all (candidate × watchlist) name pairs.
 *
 * Composite formula: 0.5*phonetic + 0.5*fuzzy (capped at 1.0). Exact
 * match short-circuits to 1.0. AI arbitration is invoked only when the
 * deterministic score lands in [0.55, 0.85] and `enableAi=true`.
 */
export async function matchNames(
  env: Env,
  candidate: { name: string; aliases?: string[] },
  watchlist: { name: string; aliases?: string[] },
  opts: MatchOptions = {},
): Promise<MatchResult> {
  const candNames = [candidate.name, ...(candidate.aliases ?? [])].filter(Boolean);
  const wlNames = [watchlist.name, ...(watchlist.aliases ?? [])].filter(Boolean);

  let best: MatchEvidence = {
    exact: 0, phonetic: 0, fuzzy: 0, best_method: "fuzzy",
  };
  let bestComposite = 0;
  let bestAlias: string | undefined;

  for (const cn of candNames) {
    for (const wn of wlNames) {
      const ex = exactScore(cn, wn);
      if (ex === 1) {
        return {
          score: 1,
          method: "exact",
          evidence: { exact: 1, phonetic: 1, fuzzy: 1, best_method: "exact", best_alias: wn },
        };
      }
      const ph = phoneticScore(cn, wn);
      const fz = fuzzyScore(cn, wn);
      const composite = Math.min(1, 0.5 * ph + 0.5 * fz);
      if (composite > bestComposite) {
        bestComposite = composite;
        bestAlias = wn;
        best = {
          exact: 0,
          phonetic: ph,
          fuzzy: fz,
          best_method: ph >= fz ? "phonetic" : "fuzzy",
          best_alias: wn,
        };
      }
    }
  }

  // AI arbitration in the ambiguous band only — cheap.
  if (opts.enableAi && bestComposite >= 0.55 && bestComposite < 0.85 && env.AI) {
    try {
      const a = opts.aiContextA ? `${candidate.name}\n${opts.aiContextA}` : candidate.name;
      const b = opts.aiContextB ? `${watchlist.name}\n${opts.aiContextB}` : watchlist.name;
      const arb = await aiArbitrate(env, a, b);
      const aiScore = arb.match === "yes" ? Math.max(0.85, arb.confidence) :
                      arb.match === "no" ? Math.min(0.4, 1 - arb.confidence) :
                      bestComposite;
      best.ai = aiScore;
      if (arb.match === "yes" && aiScore > bestComposite) {
        return {
          score: aiScore,
          method: "ai_arbitrated",
          evidence: { ...best, best_method: "ai_arbitrated" },
        };
      }
      if (arb.match === "no") {
        return {
          score: aiScore,
          method: "ai_arbitrated",
          evidence: { ...best, best_method: "ai_arbitrated" },
        };
      }
    } catch (e) {
      console.warn("matchNames AI arbitration failed", (e as Error).message);
    }
  }

  return {
    score: bestComposite,
    method: best.best_method,
    evidence: { ...best, best_alias: bestAlias },
  };
}
