// Task #8: pure metric helpers. No DB / no env — the eval runner calls
// these on in-memory predictions and persists the result. Each helper
// is unit-tested on fixtures (see src/services/mlOps/__tests__/).

export interface ConfusionRow {
  predicted: string;
  gold: string;
}

export interface ClassificationMetrics {
  accuracy: number;
  precision_macro: number;
  recall_macro: number;
  f1_macro: number;
  per_class: Record<string, { precision: number; recall: number; f1: number; support: number }>;
}

/** Multi-class classification macro-P/R/F1. */
export function classificationMetrics(rows: ConfusionRow[]): ClassificationMetrics {
  if (rows.length === 0) {
    return { accuracy: 0, precision_macro: 0, recall_macro: 0, f1_macro: 0, per_class: {} };
  }
  const classes = new Set<string>();
  for (const r of rows) { classes.add(r.gold); classes.add(r.predicted); }
  const per_class: ClassificationMetrics["per_class"] = {};
  let correct = 0;
  for (const r of rows) if (r.predicted === r.gold) correct += 1;
  let pSum = 0, rSum = 0, fSum = 0, nClasses = 0;
  for (const c of classes) {
    let tp = 0, fp = 0, fn = 0;
    for (const r of rows) {
      if (r.predicted === c && r.gold === c) tp += 1;
      else if (r.predicted === c && r.gold !== c) fp += 1;
      else if (r.predicted !== c && r.gold === c) fn += 1;
    }
    const support = tp + fn;
    if (support === 0 && tp + fp === 0) continue;
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f = p + rec === 0 ? 0 : (2 * p * rec) / (p + rec);
    per_class[c] = { precision: p, recall: rec, f1: f, support };
    pSum += p; rSum += rec; fSum += f; nClasses += 1;
  }
  return {
    accuracy: correct / rows.length,
    precision_macro: nClasses === 0 ? 0 : pSum / nClasses,
    recall_macro: nClasses === 0 ? 0 : rSum / nClasses,
    f1_macro: nClasses === 0 ? 0 : fSum / nClasses,
    per_class,
  };
}

export interface PairLabel {
  /** Predicted: are these the same entity? */
  predicted: boolean;
  /** Gold: ARE they the same entity? */
  gold: boolean;
}

export interface PairMetrics {
  precision: number;
  recall: number;
  f1: number;
  tp: number; fp: number; fn: number; tn: number;
}

/** Dedupe pair P/R/F1. positives = "same entity". */
export function pairPRF1(rows: PairLabel[]): PairMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    if (r.predicted && r.gold) tp += 1;
    else if (r.predicted && !r.gold) fp += 1;
    else if (!r.predicted && r.gold) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn, tn };
}

export interface FieldLevelRow {
  predicted: Record<string, unknown>;
  gold: Record<string, unknown>;
  /** Optional restriction; default = union of keys in gold + predicted. */
  fields?: string[];
}

export interface FieldLevelMetrics {
  precision: number;
  recall: number;
  f1: number;
  per_field: Record<string, { precision: number; recall: number; f1: number; support: number }>;
}

/** Field-level F1 for structured extraction. A field counts as a true
 * positive when both predicted + gold are non-null AND deep-equal. */
export function fieldLevelF1(rows: FieldLevelRow[]): FieldLevelMetrics {
  const fields = new Set<string>();
  for (const r of rows) {
    const ks = r.fields ?? Array.from(new Set([...Object.keys(r.gold), ...Object.keys(r.predicted)]));
    for (const k of ks) fields.add(k);
  }
  const per_field: FieldLevelMetrics["per_field"] = {};
  let totalTp = 0, totalFp = 0, totalFn = 0;
  for (const f of fields) {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (const r of rows) {
      const goldVal = r.gold[f];
      const predVal = r.predicted[f];
      const hasGold = goldVal !== undefined && goldVal !== null && goldVal !== "";
      const hasPred = predVal !== undefined && predVal !== null && predVal !== "";
      if (hasGold) support += 1;
      if (hasGold && hasPred && deepEqual(goldVal, predVal)) tp += 1;
      else if (hasPred && !hasGold) fp += 1;
      else if (hasPred && hasGold && !deepEqual(goldVal, predVal)) { fp += 1; fn += 1; }
      else if (!hasPred && hasGold) fn += 1;
    }
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = p + rec === 0 ? 0 : (2 * p * rec) / (p + rec);
    per_field[f] = { precision: p, recall: rec, f1, support };
    totalTp += tp; totalFp += fp; totalFn += fn;
  }
  const precision = totalTp + totalFp === 0 ? 0 : totalTp / (totalTp + totalFp);
  const recall = totalTp + totalFn === 0 ? 0 : totalTp / (totalTp + totalFn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, per_field };
}

export interface CalibrationRow {
  /** Predicted probability of the positive class, in [0,1]. */
  predicted: number;
  /** Observed outcome: 0 or 1. */
  actual: 0 | 1;
}

export interface CalibrationMetrics {
  brier: number;
  log_loss: number;
  mean_predicted: number;
  mean_actual: number;
  n: number;
}

/** Brier score (mean squared error) + log-loss for binary outcomes. */
export function calibrationMetrics(rows: CalibrationRow[]): CalibrationMetrics {
  if (rows.length === 0) return { brier: 0, log_loss: 0, mean_predicted: 0, mean_actual: 0, n: 0 };
  let brSum = 0, llSum = 0, pSum = 0, aSum = 0;
  const EPS = 1e-9;
  for (const r of rows) {
    const p = Math.max(EPS, Math.min(1 - EPS, r.predicted));
    const a = r.actual;
    brSum += (p - a) * (p - a);
    llSum += -(a * Math.log(p) + (1 - a) * Math.log(1 - p));
    pSum += r.predicted;
    aSum += a;
  }
  return {
    brier: brSum / rows.length,
    log_loss: llSum / rows.length,
    mean_predicted: pSum / rows.length,
    mean_actual: aSum / rows.length,
    n: rows.length,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) {
    // Coerce numeric/string for tolerant comparison on extracted JSON.
    if ((typeof a === "number" || typeof a === "string") && (typeof b === "number" || typeof b === "string")) {
      return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    }
    return false;
  }
  if (typeof a === "string") return a.trim().toLowerCase() === (b as string).trim().toLowerCase();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    // Order-insensitive list comparison for tag arrays.
    const aS = [...a].map((x) => JSON.stringify(x)).sort();
    const bS = [...b].map((x) => JSON.stringify(x)).sort();
    return aS.every((v, i) => v === bS[i]);
  }
  if (a && b && typeof a === "object") {
    const aK = Object.keys(a as object).sort();
    const bK = Object.keys(b as object).sort();
    if (aK.length !== bK.length) return false;
    return aK.every((k, i) => k === bK[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Regression gate (Task #8 spec: deploy blocked when any task metric
 *  regresses >5% vs. the previous active version). Returns the list of
 *  regressed (metric_key, delta) pairs; empty list = pass. */
export interface RegressionCheckResult {
  passed: boolean;
  regressions: { metric: string; previous: number; current: number; delta: number }[];
}

export function regressionGate(
  previous: Record<string, number> | null,
  current: Record<string, number>,
  thresholdPct = 5,
): RegressionCheckResult {
  const regressions: RegressionCheckResult["regressions"] = [];
  if (!previous) return { passed: true, regressions };
  const KEYS = ["accuracy", "precision_macro", "recall_macro", "f1_macro", "precision", "recall", "f1"];
  for (const k of KEYS) {
    const prev = previous[k];
    const cur = current[k];
    if (typeof prev !== "number" || typeof cur !== "number") continue;
    if (prev <= 0) continue;
    const deltaPct = ((prev - cur) / prev) * 100;
    if (deltaPct > thresholdPct) {
      regressions.push({ metric: k, previous: prev, current: cur, delta: -deltaPct });
    }
  }
  // Brier regresses UP (lower is better).
  if (typeof previous.brier === "number" && typeof current.brier === "number" && previous.brier > 0) {
    const deltaPct = ((current.brier - previous.brier) / previous.brier) * 100;
    if (deltaPct > thresholdPct) {
      regressions.push({ metric: "brier", previous: previous.brier, current: current.brier, delta: deltaPct });
    }
  }
  return { passed: regressions.length === 0, regressions };
}
