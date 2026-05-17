// Smart watchlist membership re-evaluation. Hourly tick.
//
// Each watchlist with `is_smart=1` carries a saved querystring/filter
// in `filter_json`. We delegate the actual filter execution to the
// existing /api/entities and /api/firms list endpoints by parsing the
// querystring and rebuilding it as a D1 query, but for v1 we support
// a small JSON filter shape so we don't have to re-implement every
// route's query builder.
//
// Supported filter_json shape:
//   { entity_kind?: "person"|"org",
//     sectors?: string[],            // ANY of
//     stages?: string[],             // ANY of
//     country?: string,              // exact iso2
//     min_fit?: number,              // entity_summary.fit_max_score >=
//     min_intent?: number,           // entity_summary.intent_score >=
//     limit?: number }              // default 500, capped at 5000

import type { Env } from "../types";
import { dispatchEvent } from "./dispatch";
import type { AlertRuleRow } from "./types";

interface SmartFilter {
  entity_kind?: string;
  sectors?: string[];
  stages?: string[];
  country?: string;
  min_fit?: number;
  min_intent?: number;
  limit?: number;
}

export async function reevaluateAllSmartWatchlists(env: Env, opts: { limit?: number } = {}): Promise<{
  watchlists: number; added: number; removed: number; failed: number;
}> {
  const limit = opts.limit ?? 50;
  const r = await env.DB.prepare(
    `SELECT id, owner_email, filter_json FROM watchlists
      WHERE is_smart = 1
        AND (last_evaluated_at IS NULL OR datetime(last_evaluated_at) < datetime('now','-1 hour'))
      ORDER BY last_evaluated_at IS NULL DESC, last_evaluated_at ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; owner_email: string; filter_json: string | null }>();

  let added = 0, removed = 0, failed = 0;
  const watchlists = (r.results ?? []).length;
  for (const wl of r.results ?? []) {
    try {
      const d = await reevaluateSmartWatchlist(env, wl.id, wl.filter_json);
      added += d.added; removed += d.removed;
    } catch (e) {
      failed++;
      console.warn("smart watchlist reeval failed", wl.id, (e as Error).message);
    }
  }
  return { watchlists, added, removed, failed };
}

export async function reevaluateSmartWatchlist(env: Env, watchlistId: string, filterJson: string | null): Promise<{
  added: number; removed: number;
}> {
  const filter = (filterJson ? safeJson<SmartFilter>(filterJson) : null) ?? {};
  const ids = await runFilter(env, filter);
  const idSet = new Set(ids);

  const current = await env.DB.prepare(
    `SELECT entity_id FROM watchlist_members WHERE watchlist_id = ?`,
  ).bind(watchlistId).all<{ entity_id: string }>();
  const currentSet = new Set((current.results ?? []).map((x) => x.entity_id));

  const toAdd = ids.filter((id) => !currentSet.has(id));
  const toRemove = [...currentSet].filter((id) => !idSet.has(id));

  const now = new Date().toISOString();
  for (const id of toAdd) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO watchlist_members (watchlist_id, entity_id, added_at, source)
        VALUES (?, ?, ?, 'smart')`,
    ).bind(watchlistId, id, now).run();
  }
  if (toRemove.length) {
    const placeholders = toRemove.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM watchlist_members WHERE watchlist_id = ? AND source = 'smart'
         AND entity_id IN (${placeholders})`,
    ).bind(watchlistId, ...toRemove).run();
  }
  await env.DB.prepare(
    `UPDATE watchlists SET member_count = (SELECT COUNT(*) FROM watchlist_members WHERE watchlist_id = ?),
       last_changed_at = CASE WHEN ? > 0 OR ? > 0 THEN ? ELSE last_changed_at END,
       last_evaluated_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(watchlistId, toAdd.length, toRemove.length, now, now, now, watchlistId).run();

  // Spec: membership changes count as any_change-style events when an
  // explicit rule is attached to the watchlist. Emit one event per
  // (added|removed) entity per matching rule via the standard dispatch
  // path (so dedupe, digest routing, channel + retry all reuse the
  // same machinery as entity-driven events).
  if (toAdd.length || toRemove.length) {
    const ruleRows = await env.DB.prepare(
      `SELECT id, owner_email, name, watchlist_id, entity_id, trigger_kind,
              trigger_config_json, channel, channel_config_json, digest_frequency,
              dedupe_window_seconds, is_active, last_fired_at, fire_count
         FROM alert_rules
        WHERE watchlist_id = ? AND is_active = 1 AND trigger_kind = 'any_change'`,
    ).bind(watchlistId).all<AlertRuleRow>();
    for (const rule of ruleRows.results ?? []) {
      for (const id of toAdd) {
        await dispatchEvent(env, rule, {
          dedupe_key: `member_added:${id}`,
          title: `Watchlist member added: ${id}`,
          body: `${id} now matches the smart watchlist filter.`,
          diff: [{ field: "watchlist_membership", old: null, new: "added" }],
          payload: { watchlist_id: watchlistId, entity_id: id, change: "added" },
        }, id).catch((e) => console.warn("smart member_added dispatch failed", id, (e as Error).message));
      }
      for (const id of toRemove) {
        await dispatchEvent(env, rule, {
          dedupe_key: `member_removed:${id}`,
          title: `Watchlist member removed: ${id}`,
          body: `${id} no longer matches the smart watchlist filter.`,
          diff: [{ field: "watchlist_membership", old: "added", new: null }],
          payload: { watchlist_id: watchlistId, entity_id: id, change: "removed" },
        }, id).catch((e) => console.warn("smart member_removed dispatch failed", id, (e as Error).message));
      }
    }
  }

  return { added: toAdd.length, removed: toRemove.length };
}

async function runFilter(env: Env, f: SmartFilter): Promise<string[]> {
  const limit = Math.min(Number(f.limit ?? 500) || 500, 5000);
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (f.entity_kind === "person" || f.entity_kind === "org") {
    wheres.push("e.kind = ?"); binds.push(f.entity_kind);
  }
  if (f.country) { wheres.push("s.country_iso2 = ?"); binds.push(String(f.country).toUpperCase()); }
  if (typeof f.min_fit === "number") { wheres.push("s.fit_max_score >= ?"); binds.push(f.min_fit); }
  if (typeof f.min_intent === "number") { wheres.push("s.intent_score >= ?"); binds.push(f.min_intent); }
  if (f.sectors?.length) {
    const ors = f.sectors.map(() => "instr(',' || s.sectors_csv || ',', ?)").join(" OR ");
    wheres.push(`(${ors})`);
    for (const s of f.sectors) binds.push(`,${s},`);
  }
  if (f.stages?.length) {
    const ors = f.stages.map(() => "instr(',' || s.stages_csv || ',', ?)").join(" OR ");
    wheres.push(`(${ors})`);
    for (const s of f.stages) binds.push(`,${s},`);
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const r = await env.DB.prepare(
    `SELECT e.id AS id FROM u_entities e
       LEFT JOIN entity_summary s ON s.entity_id = e.id
       ${whereSql}
       AND (e.status = 'active' OR e.status IS NULL)
       LIMIT ?`.replace("WHERE  AND", "WHERE ").replace("AND (e.status", whereSql ? "AND (e.status" : "WHERE (e.status"),
  ).bind(...binds, limit).all<{ id: string }>();
  return (r.results ?? []).map((x) => x.id);
}

function safeJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
