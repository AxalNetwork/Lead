// Task #45: shared types for buyer-signal crawler modules.
//
// Each source module exports a default `SourceModule`. The
// CrawlSignalsWorkflow iterates the registry hourly, calls `crawl(ctx)`,
// then persists every returned `SignalEventDraft` through the shared
// resolveAccount → insertSignal pipeline.

import type { Env } from "../../types";
import type { SignalKind } from "../signalKinds";

export interface SourceContext {
  env: Env;
  /** Per-source opaque cursor previously written back. */
  cursor: string | null;
  /** Optional override for the per-run hard cap on emitted events. */
  maxEvents?: number;
  /**
   * When set, the module MUST restrict its work to this single account
   * (used by EnrichAccountWorkflow). Modules that have no per-account
   * scoping skip themselves when this is provided.
   */
  accountId?: string;
  logger?: (msg: string) => void;
}

export interface AccountHint {
  /** Apex domain (acme.com) — preferred resolver key. */
  domain?: string;
  /** Display name; used as fallback resolver key + name on create. */
  name?: string;
  description?: string;
  industry?: string;
  hq_country_iso2?: string;
  hq_city?: string;
  website?: string;
  linkedin_url?: string;
  github_org?: string;
}

export interface BuyerHint {
  name?: string;
  email?: string;
  title?: string;
  linkedin_url?: string;
}

export interface SignalEventDraft {
  kind: SignalKind;
  /** Optional weight override; clamped [0.1,10] by insertSignal. */
  weight?: number;
  /** 0..1 confidence override; defaults to 1. */
  confidence?: number;
  /** Arbitrary structured evidence. JSON-stringified before insert. */
  payload?: unknown;
  /** Canonical URL of the evidence (job posting, news article, …). */
  evidence_url?: string;
  /** Short verbatim quote — surfaces in the dashboard tooltip. */
  evidence_snippet?: string;
  /** R2 archive key set by the crawler when it stashes raw HTML/JSON. */
  r2_key?: string;
  /** Event timestamp from the source — falls back to now() on insert. */
  occurred_at?: string;
  /** Account resolution hints — at least one of {domain, name} required. */
  account: AccountHint;
  /** Optional buyer attached to the signal. */
  buyer?: BuyerHint;
}

export interface CrawlResult {
  events: SignalEventDraft[];
  /** New cursor to persist; pass null to leave unchanged. */
  cursor?: string | null;
  /** Optional per-source counters appended to crawler_runs.meta_json. */
  meta?: Record<string, unknown>;
}

export type CrawlSchedule = "hourly" | "every6h" | "daily";

export interface SourceModule {
  slug: string;
  label: string;
  schedule: CrawlSchedule;
  /** Default enabled state; admin UI toggle stored under SCRAPE_CACHE. */
  enabledByDefault: boolean;
  /** Env key whose absence disables the source at runtime. */
  requiresEnv?: keyof Env;
  /** True when the module relies on Brave-cached snippets only (LinkedIn/FB). */
  bravePoweredOnly?: boolean;
  /** Documentation URL surfaced in the admin UI. */
  docsUrl?: string;
  crawl(ctx: SourceContext): Promise<CrawlResult>;
}
