// Pure logistic-regression model for intro conversion prediction.
// Weights are persisted in `intro_model_runs.weights_json`; the live
// model is the row with is_current=1.
//
// On a cold install with no logged outcomes, the model returns the
// DEFAULT_WEIGHTS (hand-set priors that match the spec's narrative
// of "shorter + warmer + closer-to-target wins"). When fewer than
// MIN_TRAIN_SAMPLES outcomes are logged, retraining is a no-op and
// the priors stay in place — we never publish a model that's been
// fit on too little data.

import type { IntroFeatures } from "./features";

export interface ModelWeights {
  intercept: number;
  length: number;        // applied to path_length (negative ⇒ longer paths predict worse)
  weakest_eq: number;    // positive ⇒ higher quality predicts better
  target_pr: number;     // positive
  broker: number;        // positive
  ask_match: number;     // positive
}

export const DEFAULT_WEIGHTS: ModelWeights = {
  intercept: -1.2,    // sigmoid(-1.2) ≈ 23% — a pessimistic prior for an unscored intro
  length: -0.4,       // each extra hop drops the log-odds by 0.4
  weakest_eq: 1.8,    // strong driver
  target_pr: 0.6,
  broker: 0.5,        // small bump when a known broker is on the path
  ask_match: 1.2,
};

export const MIN_TRAIN_SAMPLES = 25;

/** Convert features → log-odds. */
export function logit(w: ModelWeights, f: IntroFeatures): number {
  return (
    w.intercept
    + w.length     * f.path_length
    + w.weakest_eq * f.weakest_eq
    + w.target_pr  * f.target_pr
    + w.broker     * f.broker_in_path
    + w.ask_match  * f.ask_match
  );
}

export function sigmoid(z: number): number {
  if (z > 50) return 1;
  if (z < -50) return 0;
  return 1 / (1 + Math.exp(-z));
}

/** Predict conversion probability in [0,1]. */
export function predict(w: ModelWeights, f: IntroFeatures): number {
  return sigmoid(logit(w, f));
}

export interface TrainingSample {
  features: IntroFeatures;
  /** 1 = positive outcome (accepted | meeting_held | deal_closed),
   *  0 = negative (declined | ghosted), other statuses are filtered out
   *  upstream (see outcomeToLabel). */
  label: 0 | 1;
}

/**
 * Maps an `intro_outcomes.status` to a {0,1} training label, or `null`
 * to drop the row from training. Per spec:
 *   - positive: accepted, meeting_held, deal_closed
 *   - negative: declined, ghosted
 *   - drop:     requested, made (in-flight, no signal yet)
 */
export function outcomeToLabel(status: string): 0 | 1 | null {
  switch (status) {
    case "accepted":
    case "meeting_held":
    case "deal_closed":
      return 1;
    case "declined":
    case "ghosted":
      return 0;
    case "requested":
    case "made":
    default:
      return null;
  }
}

/**
 * Trains weights via batch gradient descent on the binary cross-entropy
 * loss. Pure — no DB access. Returns the new weights + Brier score
 * (mean squared error of predicted vs. label).
 */
export function trainLogistic(
  samples: TrainingSample[],
  opts: { lr?: number; epochs?: number; l2?: number; init?: ModelWeights } = {},
): { weights: ModelWeights; brier: number; sample_size: number; positives: number; negatives: number } {
  const lr = opts.lr ?? 0.1;
  const epochs = opts.epochs ?? 200;
  const l2 = opts.l2 ?? 0.01;
  const w: ModelWeights = { ...(opts.init ?? DEFAULT_WEIGHTS) };

  const positives = samples.reduce((a, s) => a + s.label, 0);
  const negatives = samples.length - positives;

  if (samples.length < MIN_TRAIN_SAMPLES) {
    // Not enough data — return the init unchanged and compute Brier on
    // whatever samples we have so operators can still see calibration.
    const brier = brierScore(w, samples);
    return { weights: w, brier, sample_size: samples.length, positives, negatives };
  }

  // Need at least one of each class for binary classification to be
  // meaningful; if degenerate, return init.
  if (positives === 0 || negatives === 0) {
    const brier = brierScore(w, samples);
    return { weights: w, brier, sample_size: samples.length, positives, negatives };
  }

  for (let epoch = 0; epoch < epochs; epoch++) {
    let g_int = 0, g_len = 0, g_eq = 0, g_pr = 0, g_br = 0, g_am = 0;
    for (const s of samples) {
      const p = predict(w, s.features);
      const err = p - s.label;
      g_int += err;
      g_len += err * s.features.path_length;
      g_eq  += err * s.features.weakest_eq;
      g_pr  += err * s.features.target_pr;
      g_br  += err * s.features.broker_in_path;
      g_am  += err * s.features.ask_match;
    }
    const n = samples.length;
    // L2 regularization on slope params only (not intercept).
    w.intercept  -= lr * (g_int / n);
    w.length     -= lr * (g_len / n + l2 * w.length);
    w.weakest_eq -= lr * (g_eq  / n + l2 * w.weakest_eq);
    w.target_pr  -= lr * (g_pr  / n + l2 * w.target_pr);
    w.broker     -= lr * (g_br  / n + l2 * w.broker);
    w.ask_match  -= lr * (g_am  / n + l2 * w.ask_match);
  }

  const brier = brierScore(w, samples);
  return { weights: w, brier, sample_size: samples.length, positives, negatives };
}

/** Mean squared error of predictions vs labels — lower is better. */
export function brierScore(w: ModelWeights, samples: TrainingSample[]): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) {
    const p = predict(w, s.features);
    sum += (p - s.label) ** 2;
  }
  return sum / samples.length;
}
