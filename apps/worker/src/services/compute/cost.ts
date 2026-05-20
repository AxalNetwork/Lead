// Task #9: Cost computation. Pure module — unit-tested in isolation.
//
// cost_usd = (runtime_ms / 3.6e6) × cost_per_hour_usd
//          + (tokens_used / 1000) × cost_per_1k_tokens_usd
//
// Workers-AI jobs continue writing to the existing AI-cost ledger;
// this dispatcher does NOT duplicate those rows — it only writes
// when the job actually ran on an external compute_node.

export interface CostInputs {
  runtime_ms: number;
  tokens_used: number;
  cost_per_hour_usd: number;
  cost_per_1k_tokens_usd: number;
}

export function computeCostUsd(i: CostInputs): number {
  const rt = Math.max(0, Number(i.runtime_ms) || 0);
  const tk = Math.max(0, Number(i.tokens_used) || 0);
  const hourly = Math.max(0, Number(i.cost_per_hour_usd) || 0);
  const tokenRate = Math.max(0, Number(i.cost_per_1k_tokens_usd) || 0);
  const runtimeCost = (rt / 3_600_000) * hourly;
  const tokenCost = (tk / 1000) * tokenRate;
  // Six decimals is enough granularity for a single job at GPU rates
  // while keeping the dashboard column tidy.
  return Math.round((runtimeCost + tokenCost) * 1_000_000) / 1_000_000;
}
