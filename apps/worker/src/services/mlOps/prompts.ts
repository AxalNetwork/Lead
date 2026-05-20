// Task #8: prompt_versions read/promote API.
//
// - getPrompt(env, key, salt?) returns the active prompt body + id,
//   routed by rollout_pct + salt (see abRouting.ts).
// - promotePrompt(env, key, body, …) is append-only: INSERT new row,
//   UPDATE prior active row to active=0. Old rows retained for
//   rollback.

import type { Env } from "../../types";
import { shouldRouteToNew } from "./abRouting";

export interface PromptRow {
  id: string;
  prompt_key: string;
  version: string;
  body: string;
  model_hint: string | null;
  notes: string | null;
  active: number;
  rollout_pct: number;
  previous_id: string | null;
  created_at: string;
  promoted_at: string | null;
}

export interface ResolvedPrompt {
  id: string;
  prompt_key: string;
  version: string;
  body: string;
  model_hint: string | null;
  routed_to_new: boolean;
}

/** Returns the prompt body to use for this call. Falls back to a
 *  caller-provided default when no row exists (cold install). */
export async function getPrompt(
  env: Env,
  promptKey: string,
  opts?: { salt?: string; fallbackBody?: string; fallbackVersion?: string },
): Promise<ResolvedPrompt | null> {
  let active: PromptRow | null = null;
  let prev: PromptRow | null = null;
  try {
    const activeRow = await env.DB.prepare(
      `SELECT * FROM prompt_versions WHERE prompt_key = ? AND active = 1 LIMIT 1`,
    ).bind(promptKey).first<PromptRow>();
    active = activeRow ?? null;
    if (active && active.previous_id) {
      prev = await env.DB.prepare(`SELECT * FROM prompt_versions WHERE id = ? LIMIT 1`)
        .bind(active.previous_id).first<PromptRow>() ?? null;
    }
  } catch {
    // Cold install where migration 374 hasn't run yet: caller falls back.
    return opts?.fallbackBody
      ? {
          id: "fallback",
          prompt_key: promptKey,
          version: opts.fallbackVersion ?? "fallback",
          body: opts.fallbackBody,
          model_hint: null,
          routed_to_new: false,
        }
      : null;
  }
  if (!active) {
    return opts?.fallbackBody
      ? {
          id: "fallback",
          prompt_key: promptKey,
          version: opts.fallbackVersion ?? "fallback",
          body: opts.fallbackBody,
          model_hint: null,
          routed_to_new: false,
        }
      : null;
  }
  const salt = opts?.salt ?? "";
  const routedNew = prev ? shouldRouteToNew(promptKey, salt, active.rollout_pct) : true;
  const row = routedNew ? active : (prev ?? active);
  return {
    id: row.id,
    prompt_key: row.prompt_key,
    version: row.version,
    body: row.body,
    model_hint: row.model_hint,
    routed_to_new: routedNew,
  };
}

export async function listPromptVersions(env: Env, promptKey: string): Promise<PromptRow[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM prompt_versions WHERE prompt_key = ? ORDER BY created_at DESC`,
    ).bind(promptKey).all<PromptRow>();
    return r.results ?? [];
  } catch {
    return [];
  }
}

export async function promotePrompt(
  env: Env,
  args: {
    prompt_key: string;
    version: string;
    body: string;
    model_hint?: string | null;
    notes?: string | null;
    rollout_pct?: number;
    created_by?: string;
  },
): Promise<PromptRow> {
  const prior = await env.DB.prepare(
    `SELECT id FROM prompt_versions WHERE prompt_key = ? AND active = 1 LIMIT 1`,
  ).bind(args.prompt_key).first<{ id: string }>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO prompt_versions
         (id, prompt_key, version, body, model_hint, notes, active, rollout_pct, previous_id, created_by, created_at, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id, args.prompt_key, args.version, args.body,
      args.model_hint ?? null, args.notes ?? null,
      Math.max(0, Math.min(100, args.rollout_pct ?? 100)),
      prior?.id ?? null, args.created_by ?? null, now, now,
    ),
    env.DB.prepare(
      `UPDATE prompt_versions SET active = 0 WHERE prompt_key = ? AND id != ?`,
    ).bind(args.prompt_key, id),
  ]);
  const row = await env.DB.prepare(`SELECT * FROM prompt_versions WHERE id = ?`)
    .bind(id).first<PromptRow>();
  return row!;
}

export async function setRolloutPct(env: Env, id: string, pct: number): Promise<void> {
  await env.DB.prepare(`UPDATE prompt_versions SET rollout_pct = ? WHERE id = ?`)
    .bind(Math.max(0, Math.min(100, pct)), id).run();
}
