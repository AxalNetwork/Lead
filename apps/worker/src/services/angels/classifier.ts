// Task #4: Angel-type classifier.
//
// Single canonical place that assigns `angel_type` — adapters and the
// assembler MUST NOT assign types directly. Returns top label + a
// confidence score derived from how cleanly the input matches the rule.
//
// Tie-break order (per spec): solo_capitalist → operator_angel →
// super_angel → syndicate_lead → rolling_fund_manager → casual_angel.

import type { AngelType, AngelInvestmentRow } from "./types";

export interface ClassifierInput {
  disclosed_investments_count: number;
  lead_count: number;
  median_check_usd: number | null;
  annualized_deployed_usd: number | null;
  day_job_role: string | null;        // e.g. "VP Engineering", "Chief Product Officer"
  day_job_is_tech_firm: boolean;      // whether day_job_entity has any sector tag in {software, tech, fintech, …}
  syndicate_handle: string | null;
  rolling_fund_handle: string | null;
  is_ex_founder: boolean;             // any prior career_history.role_title contains founder/co-founder
}

export interface ClassifierOutput {
  angel_type: AngelType;
  confidence: number;
  reason: string;
}

const C_LEVEL_RE = /\b(chief|c[\-\s]*level|ceo|cto|cfo|coo|cmo|cpo|cro|cso)\b/i;
const VP_RE = /\b(vp|vice\s+president|head\s+of|director\s+of|founder|co[\-\s]?founder)\b/i;

export function isOperatorTitle(role: string | null): boolean {
  if (!role) return false;
  return C_LEVEL_RE.test(role) || VP_RE.test(role);
}

export function classifyAngel(input: ClassifierInput): ClassifierOutput {
  const leadRatio = input.disclosed_investments_count > 0
    ? input.lead_count / input.disclosed_investments_count
    : 0;
  const median = input.median_check_usd ?? 0;
  const annualized = input.annualized_deployed_usd ?? 0;

  // 1. solo_capitalist — annualized > $5M, lead ≥ 30%, often ex-founder.
  if (annualized > 5_000_000 && leadRatio >= 0.30) {
    const conf = Math.min(0.95, 0.6 + (input.is_ex_founder ? 0.2 : 0) + Math.min(0.15, leadRatio / 2));
    return { angel_type: "solo_capitalist", confidence: conf,
      reason: `annualized=$${annualized.toLocaleString()} leadRatio=${leadRatio.toFixed(2)}` };
  }

  // 2. operator_angel — current C-level / VP at a tech firm, median < $250k.
  if (isOperatorTitle(input.day_job_role) && input.day_job_is_tech_firm
      && (median === 0 || median < 250_000)) {
    const conf = 0.75 + (C_LEVEL_RE.test(input.day_job_role ?? "") ? 0.1 : 0);
    return { angel_type: "operator_angel", confidence: Math.min(0.95, conf),
      reason: `role=${input.day_job_role} median=$${median.toLocaleString()}` };
  }

  // 3. super_angel — disclosed ≥ 50, median < $250k.
  if (input.disclosed_investments_count >= 50 && median > 0 && median < 250_000) {
    return { angel_type: "super_angel", confidence: 0.85,
      reason: `count=${input.disclosed_investments_count} median=$${median.toLocaleString()}` };
  }

  // 4. syndicate_lead — has syndicate handle.
  if (input.syndicate_handle) {
    return { angel_type: "syndicate_lead", confidence: 0.9,
      reason: `syndicate=${input.syndicate_handle}` };
  }

  // 5. rolling_fund_manager — has rolling-fund handle.
  if (input.rolling_fund_handle) {
    return { angel_type: "rolling_fund_manager", confidence: 0.9,
      reason: `rolling_fund=${input.rolling_fund_handle}` };
  }

  // 6. casual_angel — disclosed < 5, no clear thesis.
  return { angel_type: "casual_angel",
    confidence: input.disclosed_investments_count < 5 ? 0.7 : 0.4,
    reason: `count=${input.disclosed_investments_count}` };
}

/** Helper: compute classifier-input stats from raw investment rows. */
export function statsFromInvestments(rows: AngelInvestmentRow[]): {
  median_check_usd: number | null;
  lead_count: number;
  annualized_deployed_usd: number | null;
  last_investment_at: string | null;
} {
  const checks = rows.map((r) => r.amount_usd).filter((n): n is number => typeof n === "number" && n > 0);
  let median: number | null = null;
  if (checks.length > 0) {
    const sorted = checks.slice().sort((a, b) => a - b);
    median = sorted[Math.floor(sorted.length / 2)];
  }
  const leadCount = rows.filter((r) => r.role === "lead").length;
  let last: string | null = null;
  for (const r of rows) {
    const d = r.announced_at;
    if (d && (!last || d > last)) last = d;
  }
  // Trailing-12mo annualized deployed.
  let annualized: number | null = null;
  if (last) {
    const cutoff = new Date(last);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const recent = rows.filter((r) => r.announced_at && r.announced_at >= cutoffStr);
    const sum = recent.reduce((s, r) => s + (r.amount_usd ?? 0), 0);
    annualized = sum > 0 ? sum : null;
  }
  return { median_check_usd: median, lead_count: leadCount, annualized_deployed_usd: annualized, last_investment_at: last };
}
