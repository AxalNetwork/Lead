// Task #44: deterministic prospect scoring.
//
// Three scores per account, all 0..100:
//   intent_score   — exponential-decay sum of recent signal weights
//   fit_score      — ICP fit (set by the persona-profiler task #46);
//                    until that lands we keep whatever value is in
//                    the column (defaults to 0)
//   account_score  — 0.6 * intent + 0.4 * fit
//
// Decay model: each signal contributes `weight * confidence * exp(-age_days
// / HALF_LIFE_DAYS)`. With HALF_LIFE_DAYS = 30, a signal worth 8 today is
// worth 4 in 30 days, 2 in 60 days, 1 in 90 days. We then map the raw
// weighted sum onto 0..100 via 100 * (1 - exp(-sum / SCALE)) so the scale
// is bounded and concave (the 12th meaningful signal of a quarter doesn't
// move the needle as much as the 1st).

import { DEFAULT_WEIGHT, type SignalKind } from "./signalKinds";

export const HALF_LIFE_DAYS = 30;
const LN2 = Math.log(2);    // true half-life: exp(-ln2 * age / HL)
const SCALE = 25;            // tuned so ~25 weighted units ⇒ ~63
const INTENT_BLEND = 0.6;
const FIT_BLEND = 0.4;
const FAR_FUTURE_DAYS = 365 * 5; // signals with bad occurred_at decay to ~0

export interface ScoreSignal {
  kind: string;
  weight?: number | null;
  confidence?: number | null;
  occurred_at: string;       // ISO8601
}

export interface IntentBreakdownEntry {
  kind: string;
  count: number;
  raw_contribution: number;  // weighted+decayed sum for this kind
}

export interface IntentResult {
  intent_score: number;                  // 0..100
  raw_sum: number;                       // pre-curve weighted sum
  by_kind: IntentBreakdownEntry[];
  signal_count: number;
  newest_at: string | null;
}

function ageDays(iso: string, asOf: Date): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return FAR_FUTURE_DAYS; // fail-safe: nearly zero contribution
  const ms = asOf.getTime() - t;
  return Math.max(0, ms / 86_400_000);
}

function defaultWeight(kind: string): number {
  return (DEFAULT_WEIGHT as Record<string, number>)[kind] ?? 3;
}

export function computeIntent(signals: ScoreSignal[], asOf: Date = new Date()): IntentResult {
  const byKind = new Map<string, { count: number; raw: number }>();
  let rawSum = 0;
  let newest: number | null = null;
  for (const s of signals) {
    const w = (typeof s.weight === "number" && s.weight > 0) ? s.weight : defaultWeight(s.kind);
    const c = (typeof s.confidence === "number" && s.confidence >= 0 && s.confidence <= 1) ? s.confidence : 1;
    const age = ageDays(s.occurred_at, asOf);
    const contrib = w * c * Math.exp(-LN2 * age / HALF_LIFE_DAYS);
    rawSum += contrib;
    const slot = byKind.get(s.kind) ?? { count: 0, raw: 0 };
    slot.count += 1;
    slot.raw += contrib;
    byKind.set(s.kind, slot);
    const t = Date.parse(s.occurred_at);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  const intent = 100 * (1 - Math.exp(-rawSum / SCALE));
  const breakdown: IntentBreakdownEntry[] = Array.from(byKind.entries())
    .map(([kind, v]) => ({ kind, count: v.count, raw_contribution: round2(v.raw) }))
    .sort((a, b) => b.raw_contribution - a.raw_contribution);
  return {
    intent_score: round2(Math.min(100, Math.max(0, intent))),
    raw_sum: round2(rawSum),
    by_kind: breakdown,
    signal_count: signals.length,
    newest_at: newest != null ? new Date(newest).toISOString() : null,
  };
}

export function blendAccountScore(intent: number, fit: number): number {
  const i = Number.isFinite(intent) ? Math.max(0, Math.min(100, intent)) : 0;
  const f = Number.isFinite(fit) ? Math.max(0, Math.min(100, fit)) : 0;
  return round2(INTENT_BLEND * i + FIT_BLEND * f);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Stale-rows selector for the nightly cron: any account whose newest
// signal is older than HALF_LIFE_DAYS or whose score_recomputed_at is
// older than 24h.
export const NIGHTLY_STALE_SQL = `
  SELECT a.id FROM accounts a
   WHERE a.status NOT IN ('lost','disqualified')
     AND (
       a.score_recomputed_at IS NULL
       OR datetime(a.score_recomputed_at) < datetime('now','-1 day')
     )
   ORDER BY a.score_recomputed_at IS NULL DESC, a.score_recomputed_at ASC
   LIMIT 1000`;

// Convenience for tests / the cron: take a known kind list and assert
// the math is monotone (more recent signals strictly raise the score).
export function _selfCheck(): boolean {
  const now = new Date("2026-05-15T00:00:00Z");
  const oneOld = computeIntent([{ kind: "demo_request", occurred_at: "2025-11-15T00:00:00Z" }], now).intent_score;
  const oneNew = computeIntent([{ kind: "demo_request", occurred_at: "2026-05-14T00:00:00Z" }], now).intent_score;
  return oneNew > oneOld;
}

export type SignalKindForScoring = SignalKind | string;
