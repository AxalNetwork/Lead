// Pivot orchestrator (Task #3).
//
// Runs the registered pivots in parallel with a per-pivot timeout and a
// global wall-clock budget. Cancellation: every pivot receives an
// AbortSignal and a `deadlineMs` so they can self-terminate cleanly.
//
// Pivots are intentionally pure functions over (env, facts, ctx) → PivotHit[].
// All side-effects (negative-cache writes, DB writes, EntityLock) happen
// in resolve.ts after scoring + guardrails.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit, PivotResult } from "../types";

import { runKeybaseProofs } from "./keybase_proofs";
import { runWellKnownPaths } from "./well_known_paths";
import { runCryptoIdentity } from "./crypto_identity";
import { runBioUrlChain } from "./bio_url_chain";
import { runGravatarLookup } from "./gravatar_lookup";
import { runHackerNewsCorrelation } from "./hackernews_correlation";
import { runRedditCorrelation } from "./reddit_correlation";
import { runUsernameEnumeration } from "./username_enumeration";
import { runAvatarPhashMatch } from "./avatar_phash_match";
import { runWritingStyle } from "./writing_style";
import { runMutualFollowers } from "./mutual_followers";

type PivotFn = (env: Env, facts: KnownEntityFacts, ctx: PivotContext) => Promise<PivotHit[]>;

export const PIVOTS: Array<{ name: string; fn: PivotFn; perPivotMs: number }> = [
  // Cryptographic / high-trust pivots first — they short-circuit auto-link.
  { name: "keybase_proofs",   fn: runKeybaseProofs,         perPivotMs: 8000 },
  { name: "well_known",       fn: runWellKnownPaths,        perPivotMs: 8000 },
  { name: "crypto_identity",  fn: runCryptoIdentity,        perPivotMs: 8000 },
  { name: "bio_url_chain",    fn: runBioUrlChain,           perPivotMs: 8000 },
  { name: "gravatar",         fn: runGravatarLookup,        perPivotMs: 5000 },
  // Behavioral / correlation pivots
  { name: "hackernews",       fn: runHackerNewsCorrelation, perPivotMs: 6000 },
  { name: "reddit",           fn: runRedditCorrelation,     perPivotMs: 6000 },
  // Username sweep — the longest pivot; comes after the rest so its budget
  // is not eaten when one of the high-trust pivots already proved identity.
  { name: "username",         fn: runUsernameEnumeration,   perPivotMs: 20000 },
  // Heavier pivots
  { name: "avatar_phash",     fn: runAvatarPhashMatch,      perPivotMs: 8000 },
  { name: "writing_style",    fn: runWritingStyle,          perPivotMs: 6000 },
  { name: "mutual_followers", fn: runMutualFollowers,       perPivotMs: 8000 },
];

export interface OrchestratorOptions {
  totalBudgetMs?: number;     // default 60s
  enabledPivots?: string[];   // restrict subset
  useNegativeCache?: boolean; // default true; off for reverify
  platformCap?: number;       // hard limit on platforms probed
}

export async function runAllPivots(
  env: Env,
  facts: KnownEntityFacts,
  opts: OrchestratorOptions = {},
): Promise<PivotResult[]> {
  const total = opts.totalBudgetMs ?? 60_000;
  const deadline = Date.now() + total;
  const enabled = opts.enabledPivots
    ? new Set(opts.enabledPivots)
    : new Set(PIVOTS.map((p) => p.name));
  const ctx: PivotContext = {
    deadlineMs: deadline,
    useNegativeCache: opts.useNegativeCache !== false,
    platformCap: opts.platformCap,
  };

  const results = await Promise.all(
    PIVOTS.filter((p) => enabled.has(p.name)).map(async (p) => {
      if (Date.now() > deadline) {
        return { pivot: p.name, hits: [], durationMs: 0, error: "global_budget_exhausted" } satisfies PivotResult;
      }
      const start = Date.now();
      const slice = Math.min(p.perPivotMs, Math.max(500, deadline - Date.now()));
      try {
        const hits = await withTimeout(p.fn(env, facts, ctx), slice, p.name);
        return { pivot: p.name, hits, durationMs: Date.now() - start } satisfies PivotResult;
      } catch (e) {
        return {
          pivot: p.name,
          hits: [],
          durationMs: Date.now() - start,
          error: (e as Error).message,
        } satisfies PivotResult;
      }
    }),
  );
  return results;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`pivot_timeout:${label}:${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}
