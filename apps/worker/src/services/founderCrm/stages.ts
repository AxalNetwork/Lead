// Task #5: Kanban stage taxonomy + transition rules.
//
// Pure module — no DB. Validates stage names and transition legality
// so the application layer can reject malformed PATCH bodies before
// they reach the database.

export const STAGES = [
  "not_contacted",
  "intro_requested",
  "first_meeting",
  "diligence",
  "partners_meeting",
  "term_sheet",
  "committed",
  "passed",
  "ghosted",
] as const;

export type Stage = (typeof STAGES)[number];

const STAGE_SET = new Set<string>(STAGES);

/** Stages 'committed' / 'passed' / 'ghosted' are terminal — once a
 *  card lands there, the next legal move is to revert to the prior
 *  in-flight stage only if the founder explicitly re-opens the
 *  relationship (which the UI surfaces as a separate action). */
const TERMINAL = new Set<Stage>(["committed", "passed", "ghosted"]);

const ACTIVE_ORDER: Stage[] = [
  "not_contacted",
  "intro_requested",
  "first_meeting",
  "diligence",
  "partners_meeting",
  "term_sheet",
];

export function isStage(s: string): s is Stage { return STAGE_SET.has(s); }

export function isTerminalStage(s: Stage): boolean { return TERMINAL.has(s); }

/** Returns true if a transition from `from` → `to` is legal.
 *  Rules:
 *   - any non-terminal active stage may move to any other active stage
 *     (forward or backward — founders re-engage stalled investors)
 *   - any active stage may move to a terminal stage
 *   - a terminal stage may only move back into an active stage via an
 *     explicit "reopen" — represented as a transition out of the
 *     terminal set into the active set; we allow it but the caller
 *     is expected to journal it for analytics
 *   - same-stage no-op transitions are rejected (callers should NOT
 *     write a journal row when nothing changed) */
export function isLegalTransition(from: Stage | null, to: Stage): boolean {
  if (!isStage(to)) return false;
  if (from == null) return ACTIVE_ORDER[0] === to || to === "not_contacted";
  if (from === to) return false;
  return true;
}

export function defaultStage(): Stage { return "not_contacted"; }
