// Shared types for the OSINT layer (Task #3).

import type { PlatformSlug } from "./platforms";

export type LinkMethod =
  | "manual"
  | "keybase"
  | "well_known"
  | "crypto_ens"
  | "crypto_lens"
  | "crypto_farcaster"
  | "rel_me"
  | "same_as"
  | "bio_url"
  | "gravatar"
  | "hackernews"
  | "reddit"
  | "username"
  | "avatar_phash"
  | "stylometric"
  | "mutual_followers"
  | "reverify";

export interface PivotHit {
  platform: PlatformSlug;
  handle: string;
  url?: string;
  link_method: LinkMethod;
  base_confidence: number;       // 0..1 pre-guardrail
  evidence_json: Record<string, unknown>;
  ttl_seconds?: number;          // optional override for negative cache
}

export interface PivotContext {
  jobId?: string;
  // Hard wall-clock deadline (Date.now()-based) for this run.
  deadlineMs: number;
  // Whether negative-cache lookups are allowed (off in re-verify mode).
  useNegativeCache: boolean;
  // Cap of distinct platforms the orchestrator will probe per run.
  platformCap?: number;
}

export interface PivotResult {
  pivot: string;
  hits: PivotHit[];
  durationMs: number;
  error?: string;
}

export interface ResolveSummary {
  entityId: string;
  pivots: PivotResult[];
  autoLinked: number;
  candidatesAdded: number;
  conflictsSurfaced: number;
  totalMs: number;
}

export interface KnownEntityFacts {
  entityId: string;
  displayName: string | null;
  emails: string[];
  knownHandles: Array<{ platform: PlatformSlug; handle: string; url: string | null }>;
  walletAddresses: string[];
  personalSites: string[];
}
