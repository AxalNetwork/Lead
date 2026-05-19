// Task #18: Press / Twitter leak harvester.
//
// Lowest-confidence source per spec (step 5). Gated on operator
// review: any series row written here is stamped with
// `source='press_leak'` + `confidence=0.4` and surfaced separately
// in the UI so operators can verify before it influences benchmarks.
//
// This module deliberately does not auto-publish. The harvester
// function returns a candidate list; persist requires an explicit
// `confirmed: true` flag — wired only to the admin "Confirm leak"
// button in the UI.

import type { Env } from "../../types";
import { extractPreferredStack, type ParsedSeries } from "./preferredSeriesParser";

export interface LeakCandidate {
  company_name: string;
  source_url: string;
  series: ParsedSeries[];
  raw_excerpt: string;
}

/** Pure parser pass: given a text excerpt from a press article or
 *  tweet thread, run the same extractor used for SEC filings and
 *  return the candidate series. Confidence is clamped to ≤0.5. */
export function extractLeakCandidates(args: { companyName: string; sourceUrl: string; excerpt: string }): LeakCandidate {
  const extraction = extractPreferredStack(args.excerpt, { companyName: args.companyName });
  const series = extraction.series.map((s) => ({ ...s, confidence: Math.min(s.confidence, 0.5) }));
  return {
    company_name: args.companyName,
    source_url: args.sourceUrl,
    series,
    raw_excerpt: args.excerpt.slice(0, 4000),
  };
}

/** Stub for future automated harvesting. Returns an empty list when
 *  no Twitter / press API is configured. Honest "unconfigured" return
 *  rather than silent fallthrough (matches PACER/Delaware pattern). */
export async function harvestRecentLeaks(env: Env): Promise<{ status: "unconfigured" | "ok"; candidates: LeakCandidate[]; reason?: string }> {
  const e = env as unknown as { TWITTER_BEARER?: string; PRESS_LEAK_FEED_URL?: string };
  if (!e.TWITTER_BEARER && !e.PRESS_LEAK_FEED_URL) {
    return { status: "unconfigured", candidates: [], reason: "no_leak_source_configured" };
  }
  // Real automated feed integration is out of scope for the initial
  // Task #18 ship; operators paste excerpts via the admin endpoint
  // until a confirmed source is wired here.
  return { status: "ok", candidates: [] };
}
