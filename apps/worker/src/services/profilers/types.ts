// Task #5: Individual profiler enricher contract.
//
// Every enricher returns a typed EnricherResult whose `writes` field is a
// discriminated union mapping cleanly to a Task #4 EntityService helper.
// The orchestrator (applyWrites.ts) dispatches on `kind` — enrichers
// NEVER touch SQL directly.

import type { Env } from "../../types";
import type {
  AppreciationSignalInput, BoardSeatInput, CareerEntryInput,
  ConferenceAttendanceInput, ConversationHookInput, EducationInput,
  FamilyTieInput, GoalInput, IdentityInput, InterestInput,
  LifestyleSignalInput, PreferenceInput, TravelPatternInput,
} from "../../entities/profile-shapes";

export type EnricherCategory =
  | "career" | "education" | "interests" | "cuisine" | "travel"
  | "family" | "causes" | "health" | "media" | "network" | "goals"
  | "hooks" | "pain_point" | "purchase_signal" | "schedule"
  | "communication" | "mutual" | "competitive" | "appreciation" | "voice";

export type StructuredWrite =
  | { kind: "identity"; input: IdentityInput }
  | { kind: "career"; input: CareerEntryInput }
  | { kind: "board_seat"; input: BoardSeatInput }
  | { kind: "education"; input: EducationInput }
  | { kind: "family_tie"; input: FamilyTieInput }   // is_public=true only via this path
  | { kind: "preference"; input: PreferenceInput }
  | { kind: "interest"; input: InterestInput }
  | { kind: "lifestyle"; input: LifestyleSignalInput }
  | { kind: "travel"; input: TravelPatternInput }
  | { kind: "conference"; input: ConferenceAttendanceInput }
  | { kind: "goal"; input: GoalInput }
  | { kind: "hook"; input: ConversationHookInput }
  | { kind: "appreciation"; input: AppreciationSignalInput };

export interface CostLog {
  neurons: number;
  fetches: number;
  bytes: number;
  wall_ms: number;
  est_usd: number;
}

export interface EnricherResult {
  writes: StructuredWrite[];
  cost: CostLog;
  /** When set, the enricher self-skipped (privacy gate, missing key, no signal). */
  skipped?: { reason: string };
  /** Set when the enricher threw or returned a hard error mid-run. */
  error?: string;
}

export interface PrivacySignals {
  respects_privacy: boolean;
  reasons: string[];   // e.g. ["locked_x_account", "no_press_bio"]
}

export interface EnricherContext {
  runId: string;
  /** ISO timestamp the workflow started. */
  startedAt: string;
  /** Deadline in epoch-ms after which the enricher should bail out. */
  deadlineEpochMs: number;
  /** Privacy signals computed once per run. */
  privacy: PrivacySignals;
  /** Entity row for convenience. */
  entity: {
    id: string;
    display_name: string | null;
    primary_url: string | null;
    primary_domain: string | null;
    primary_linkedin_key: string | null;
    primary_twitter_handle: string | null;
    primary_github_handle: string | null;
  };
}

export interface Enricher {
  name: string;
  category: EnricherCategory;
  /** When true, the orchestrator hard-skips this enricher whenever
   *  `ctx.privacy.respects_privacy === true`. */
  respectsPrivacy: boolean;
  /** Upper-bound dollar estimate per single run. Used by the orchestrator
   *  to pre-empt under tight budget. Computed from env (provider keys). */
  estCostUsd: (env: Env) => number;
  run: (env: Env, entityId: string, ctx: EnricherContext) => Promise<EnricherResult>;
}

export function emptyCost(): CostLog {
  return { neurons: 0, fetches: 0, bytes: 0, wall_ms: 0, est_usd: 0 };
}

export function skipped(reason: string, wall_ms = 0): EnricherResult {
  return { writes: [], cost: { ...emptyCost(), wall_ms }, skipped: { reason } };
}
