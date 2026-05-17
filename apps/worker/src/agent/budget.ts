// Task #3: per-owner daily token budget.
//
// Token usage is the sum of `tokens_in + tokens_out` on `agent_messages`
// for the given owner_email on today's UTC date. The cap is configurable
// via `AGENT_DAILY_TOKEN_BUDGET` (default 200000). Exceeding the cap
// causes /api/agent/ask to short-circuit with a `budget_exceeded` SSE
// event and a friendly message — no model call is made.

import type { Env } from "../types";

const DEFAULT_BUDGET = 200000;

export interface BudgetStatus {
  used: number;
  cap: number;
  remaining: number;
  exceeded: boolean;
}

export function dailyCap(env: Env): number {
  const raw = env.AGENT_DAILY_TOKEN_BUDGET;
  if (!raw) return DEFAULT_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BUDGET;
}

export async function getBudget(env: Env, ownerEmail: string): Promise<BudgetStatus> {
  const cap = dailyCap(env);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS used
       FROM agent_messages
      WHERE owner_email = ?
        AND created_at >= datetime('now','start of day')`,
  ).bind(ownerEmail).first<{ used: number }>();
  const used = Number(row?.used ?? 0);
  return { used, cap, remaining: Math.max(0, cap - used), exceeded: used >= cap };
}

// Cheap token estimator: ~4 chars/token. Good enough for budget accounting
// because Workers AI doesn't return token counts on every model.
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
