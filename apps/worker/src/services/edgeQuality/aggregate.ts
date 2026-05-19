// Quality-signal aggregation.
//
// Each signal is a {value:0..1, observed_at?:ISO} pair. Signals older
// than 2 years receive a 0.5× decay multiplier per the Task #3 spec.
// The final quality_score is the weighted mean of decayed values
// clamped to [0,1]. Per-signal weights are uniform here; downstream
// can tune by editing SIGNAL_WEIGHTS.
//
// Pure module — no DB.

export type SignalKey =
  | "co_investment_5y"
  | "public_co_mentions"
  | "board_time_overlap"
  | "twitter_reply_rate"
  | "linkedin_endorsements"
  | "joint_panels"
  | "same_firm_or_school"
  | "mutual_jaccard";

export interface RawSignal {
  /** Raw value in [0, 1]. Collectors must clamp before returning. */
  value: number;
  /** ISO timestamp of the latest observation backing this signal. */
  observed_at?: string | null;
}

export interface SignalBundle {
  signals: Partial<Record<SignalKey, RawSignal>>;
  /**
   * Latest interaction observed across all signals — used to set
   * rel_edges.last_interaction_at. Optional; defaults to the max
   * observed_at across signals when omitted.
   */
  last_interaction_at?: string | null;
}

export interface AggregateOutput {
  quality_score: number;
  signals_breakdown: Record<string, {
    raw: number;
    decayed: number;
    observed_at: string | null;
    age_years: number | null;
  }>;
  last_interaction_at: string | null;
}

const SIGNAL_WEIGHTS: Record<SignalKey, number> = {
  co_investment_5y: 1.25,
  public_co_mentions: 1.0,
  board_time_overlap: 1.25,
  twitter_reply_rate: 0.75,
  linkedin_endorsements: 1.0,
  joint_panels: 0.75,
  same_firm_or_school: 1.0,
  mutual_jaccard: 1.0,
};

const TWO_YEARS_MS = 2 * 365.25 * 24 * 3600 * 1000;
const DECAY_MULTIPLIER = 0.5;

export function aggregateSignals(bundle: SignalBundle, nowIso?: string): AggregateOutput {
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const breakdown: AggregateOutput["signals_breakdown"] = {};
  let weightedSum = 0;
  let weightTotal = 0;
  let latestObserved: number | null = null;

  for (const k of Object.keys(SIGNAL_WEIGHTS) as SignalKey[]) {
    const raw = bundle.signals[k];
    if (!raw) continue;
    const v = clamp01(raw.value);
    const obsMs = raw.observed_at ? Date.parse(raw.observed_at) : NaN;
    const valid = Number.isFinite(obsMs);
    const ageMs = valid ? Math.max(0, now - obsMs) : 0;
    const ageYears = valid ? ageMs / (365.25 * 24 * 3600 * 1000) : null;
    const decayed = valid && ageMs > TWO_YEARS_MS ? v * DECAY_MULTIPLIER : v;
    const weight = SIGNAL_WEIGHTS[k];
    weightedSum += decayed * weight;
    weightTotal += weight;
    breakdown[k] = {
      raw: v,
      decayed: round3(decayed),
      observed_at: raw.observed_at ?? null,
      age_years: ageYears === null ? null : Number(ageYears.toFixed(2)),
    };
    if (valid && (latestObserved === null || obsMs > latestObserved)) {
      latestObserved = obsMs;
    }
  }

  const quality_score = weightTotal === 0 ? 0 : clamp01(weightedSum / weightTotal);
  const last_interaction_at =
    bundle.last_interaction_at
      ?? (latestObserved !== null ? new Date(latestObserved).toISOString() : null);

  return {
    quality_score: round3(quality_score),
    signals_breakdown: breakdown,
    last_interaction_at,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
