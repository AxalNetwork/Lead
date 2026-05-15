// Task #44: prospect data-access layer.
//
// Centralizes the SQL for accounts/buyers/signals/account_tech/account_history
// so route handlers and the cron can share it. Returns plain row shapes;
// JSON-decoding lives in the route layer.

import type { Env } from "../types";
import { assertSignalKind, DEFAULT_WEIGHT, type SignalKind } from "./signalKinds";
import { blendAccountScore, computeIntent, type IntentResult } from "./score";

export interface AccountRow {
  id: string;
  name: string;
  legal_name: string | null;
  domain: string | null;
  website: string | null;
  logo_id: string | null;
  description: string | null;
  industry: string | null;
  industries_json: string | null;
  size_band: string | null;
  employees: number | null;
  founded_year: number | null;
  hq_country_iso2: string | null;
  hq_region: string | null;
  hq_city: string | null;
  timezone: string | null;
  funding_stage: string | null;
  total_funding_usd: number | null;
  last_round_usd: number | null;
  last_round_at: string | null;
  revenue_band: string | null;
  linkedin_url: string | null;
  crunchbase_url: string | null;
  twitter_handle: string | null;
  github_org: string | null;
  status: string;
  owner_email: string | null;
  fit_score: number;
  intent_score: number;
  account_score: number;
  fit_breakdown_json: string | null;
  intent_breakdown_json: string | null;
  score_recomputed_at: string | null;
  embedding_dim: number | null;
  embedded_at: string | null;
  source_url: string | null;
  imported_from: string | null;
  meta_json: string | null;
  last_enriched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuyerRow {
  id: string;
  account_id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  role_slug: string | null;
  seniority: string | null;
  department: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  phone: string | null;
  is_decision_maker: number;
  is_champion: number;
  influence_score: number;
  last_seen_at: string | null;
  meta_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignalRow {
  id: string;
  account_id: string;
  buyer_id: string | null;
  kind: string;
  source: string | null;
  weight: number;
  confidence: number;
  payload_json: string | null;
  evidence_url: string | null;
  occurred_at: string;
  observed_at: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

const ACCOUNT_COLS = `id,name,legal_name,domain,website,logo_id,description,
  industry,industries_json,size_band,employees,founded_year,
  hq_country_iso2,hq_region,hq_city,timezone,funding_stage,
  total_funding_usd,last_round_usd,last_round_at,revenue_band,
  linkedin_url,crunchbase_url,twitter_handle,github_org,
  status,owner_email,fit_score,intent_score,account_score,
  fit_breakdown_json,intent_breakdown_json,score_recomputed_at,
  embedding_dim,embedded_at,source_url,imported_from,meta_json,
  last_enriched_at,created_at,updated_at`;

const ACCOUNT_INSERT_FIELDS: Array<keyof AccountRow> = [
  "id","name","legal_name","domain","website","logo_id","description",
  "industry","industries_json","size_band","employees","founded_year",
  "hq_country_iso2","hq_region","hq_city","timezone","funding_stage",
  "total_funding_usd","last_round_usd","last_round_at","revenue_band",
  "linkedin_url","crunchbase_url","twitter_handle","github_org",
  "status","owner_email","source_url","imported_from","meta_json",
];

export interface AccountListFilters {
  q?: string;
  status?: string;
  industry?: string;
  size_band?: string;
  country?: string;
  owner_email?: string;
  funding_stage?: string;
  min_intent?: number;
  min_fit?: number;
  min_account_score?: number;
  has_signal_kind?: string;
  signal_within_days?: number;
  vendor?: string;             // account_tech vendor slug
  sort?: "account_score" | "intent_score" | "fit_score" | "name" | "updated_at";
  limit?: number;
  offset?: number;
}

export interface AccountListAggregates {
  total: number;
  by_status: Array<{ k: string; n: number }>;
  by_size: Array<{ k: string; n: number }>;
  by_industry: Array<{ k: string; n: number }>;
  avg_account_score: number;
  avg_intent_score: number;
  avg_fit_score: number;
}

export async function listAccounts(env: Env, f: AccountListFilters): Promise<{ items: AccountRow[]; nextOffset: number | null; aggregates: AccountListAggregates }> {
  const where: string[] = ["1=1"];
  const binds: unknown[] = [];
  if (f.status) { where.push("a.status = ?"); binds.push(f.status); }
  if (f.industry) { where.push("(a.industry = ? OR a.industries_json LIKE ?)"); binds.push(f.industry, `%"${f.industry}"%`); }
  if (f.size_band) { where.push("a.size_band = ?"); binds.push(f.size_band); }
  if (f.country) { where.push("a.hq_country_iso2 = ?"); binds.push(f.country.toUpperCase()); }
  if (f.owner_email) { where.push("a.owner_email = ?"); binds.push(f.owner_email); }
  if (f.funding_stage) { where.push("a.funding_stage = ?"); binds.push(f.funding_stage); }
  if (typeof f.min_intent === "number") { where.push("a.intent_score >= ?"); binds.push(f.min_intent); }
  if (typeof f.min_fit === "number") { where.push("a.fit_score >= ?"); binds.push(f.min_fit); }
  if (typeof f.min_account_score === "number") { where.push("a.account_score >= ?"); binds.push(f.min_account_score); }
  if (f.q) {
    where.push("(lower(a.name) LIKE ? OR lower(a.domain) LIKE ?)");
    binds.push(`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`);
  }
  if (f.has_signal_kind || typeof f.signal_within_days === "number") {
    const sub: string[] = ["s.account_id = a.id"];
    if (f.has_signal_kind) { sub.push("s.kind = ?"); binds.push(f.has_signal_kind); }
    if (typeof f.signal_within_days === "number") {
      sub.push(`datetime(s.occurred_at) >= datetime('now', ?)`);
      binds.push(`-${Math.max(0, Math.floor(f.signal_within_days))} days`);
    }
    where.push(`EXISTS (SELECT 1 FROM signals s WHERE ${sub.join(" AND ")})`);
  }
  if (f.vendor) {
    where.push(`EXISTS (SELECT 1 FROM account_tech t WHERE t.account_id = a.id AND t.vendor = ?)`);
    binds.push(f.vendor);
  }
  const sortCol = (() => {
    switch (f.sort) {
      case "intent_score": return "a.intent_score DESC";
      case "fit_score": return "a.fit_score DESC";
      case "name": return "lower(a.name) ASC";
      case "updated_at": return "a.updated_at DESC";
      default: return "a.account_score DESC";
    }
  })();
  const limit = Math.min(Math.max(1, f.limit ?? 50), 200);
  const offset = Math.max(0, f.offset ?? 0);
  const sql = `SELECT ${ACCOUNT_COLS} FROM accounts a WHERE ${where.join(" AND ")}
               ORDER BY ${sortCol}, a.id ASC
               LIMIT ? OFFSET ?`;
  const r = await env.DB.prepare(sql).bind(...binds, limit + 1, offset).all<AccountRow>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const aggregates = await computeAggregates(env, where, binds);
  return { items, nextOffset: hasMore ? offset + limit : null, aggregates };
}

async function computeAggregates(env: Env, where: string[], binds: unknown[]): Promise<AccountListAggregates> {
  const whereSql = where.join(" AND ");
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n,
    AVG(account_score) AS avg_a, AVG(intent_score) AS avg_i, AVG(fit_score) AS avg_f
    FROM accounts a WHERE ${whereSql}`).bind(...binds).first<{ n: number; avg_a: number | null; avg_i: number | null; avg_f: number | null }>();
  const byStatus = await env.DB.prepare(`SELECT a.status AS k, COUNT(*) AS n FROM accounts a WHERE ${whereSql} GROUP BY a.status ORDER BY n DESC`).bind(...binds).all<{ k: string; n: number }>();
  const bySize = await env.DB.prepare(`SELECT a.size_band AS k, COUNT(*) AS n FROM accounts a WHERE ${whereSql} AND a.size_band IS NOT NULL GROUP BY a.size_band ORDER BY n DESC`).bind(...binds).all<{ k: string; n: number }>();
  const byIndustry = await env.DB.prepare(`SELECT a.industry AS k, COUNT(*) AS n FROM accounts a WHERE ${whereSql} AND a.industry IS NOT NULL GROUP BY a.industry ORDER BY n DESC LIMIT 10`).bind(...binds).all<{ k: string; n: number }>();
  return {
    total: totalRow?.n ?? 0,
    by_status: byStatus.results ?? [],
    by_size: bySize.results ?? [],
    by_industry: byIndustry.results ?? [],
    avg_account_score: round2(totalRow?.avg_a ?? 0),
    avg_intent_score: round2(totalRow?.avg_i ?? 0),
    avg_fit_score: round2(totalRow?.avg_f ?? 0),
  };
}

function round2(n: number | null): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export async function getAccount(env: Env, id: string): Promise<AccountRow | null> {
  const r = await env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  return r ?? null;
}

export async function insertAccount(env: Env, input: Partial<AccountRow> & { name: string }, by?: string): Promise<AccountRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const row: Partial<AccountRow> = {
    ...input,
    id,
    status: input.status ?? "active",
  };
  const cols = ACCOUNT_INSERT_FIELDS;
  const binds = cols.map((k) => (row as Record<string, unknown>)[k] ?? null);
  const sql = `INSERT INTO accounts (${cols.join(",")}, created_at, updated_at)
               VALUES (${cols.map(() => "?").join(",")}, ?, ?)`;
  await env.DB.prepare(sql).bind(...binds, now, now).run();
  if (by) {
    await env.DB.prepare(`INSERT INTO account_history (id, account_id, field, new_value, source, changed_by) VALUES (?, ?, 'created', ?, 'api', ?)`)
      .bind(crypto.randomUUID(), id, input.name, by).run();
  }
  return (await getAccount(env, id))!;
}

export async function updateAccount(env: Env, id: string, patch: Partial<AccountRow>, by?: string, prevSnapshot?: AccountRow | null): Promise<AccountRow | null> {
  // `prevSnapshot` lets callers (route handlers that run a DO merge before
  // calling us) pass a pre-merge view of the row so the change-history diff
  // captures real before/after values. Without it we'd be diffing against
  // the post-merge row and silently dropping every history entry.
  const cur = prevSnapshot !== undefined ? prevSnapshot : await getAccount(env, id);
  if (!cur) return null;
  const allowed = new Set(ACCOUNT_INSERT_FIELDS as string[]);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const histRows: Array<{ field: string; old: unknown; nw: unknown }> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k) || k === "id") continue;
    sets.push(`${k} = ?`);
    binds.push(v);
    const before = (cur as unknown as Record<string, unknown>)[k];
    if (before !== v) {
      histRows.push({ field: k, old: before, nw: v });
    }
  }
  if (!sets.length) return cur;
  const now = new Date().toISOString();
  binds.push(now, id);
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds).run();
  for (const h of histRows) {
    await env.DB.prepare(`INSERT INTO account_history (id, account_id, field, old_value, new_value, source, changed_by) VALUES (?, ?, ?, ?, ?, 'api', ?)`)
      .bind(crypto.randomUUID(), id, h.field, h.old != null ? String(h.old) : null, h.nw != null ? String(h.nw) : null, by ?? null).run();
  }
  return await getAccount(env, id);
}

export async function deleteAccount(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM buyers WHERE account_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM signals WHERE account_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM account_tech WHERE account_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM account_history WHERE account_id = ?`).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ----- buyers
export async function listBuyers(env: Env, accountId: string): Promise<BuyerRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM buyers WHERE account_id = ? ORDER BY is_decision_maker DESC, influence_score DESC, lower(name) ASC`).bind(accountId).all<BuyerRow>();
  return r.results ?? [];
}

export async function getBuyer(env: Env, id: string): Promise<BuyerRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM buyers WHERE id = ?`).bind(id).first<BuyerRow>();
  return r ?? null;
}

export async function insertBuyer(env: Env, input: Partial<BuyerRow> & { account_id: string }): Promise<BuyerRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO buyers (id, account_id, name, email, title, role_slug, seniority, department,
      linkedin_url, twitter_url, phone, is_decision_maker, is_champion, influence_score, last_seen_at, meta_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.account_id, input.name ?? null, input.email ?? null, input.title ?? null,
          input.role_slug ?? null, input.seniority ?? null, input.department ?? null,
          input.linkedin_url ?? null, input.twitter_url ?? null, input.phone ?? null,
          input.is_decision_maker ?? 0, input.is_champion ?? 0, input.influence_score ?? 0,
          input.last_seen_at ?? null, input.meta_json ?? null, now, now)
    .run();
  return (await getBuyer(env, id))!;
}

export async function updateBuyer(env: Env, id: string, patch: Partial<BuyerRow>): Promise<BuyerRow | null> {
  const cur = await getBuyer(env, id);
  if (!cur) return null;
  const allowed = new Set(["name","email","title","role_slug","seniority","department","linkedin_url","twitter_url","phone","is_decision_maker","is_champion","influence_score","last_seen_at","meta_json"]);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return cur;
  binds.push(new Date().toISOString(), id);
  await env.DB.prepare(`UPDATE buyers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...binds).run();
  return await getBuyer(env, id);
}

export async function deleteBuyer(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM buyers WHERE id = ?`).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ----- signals
export interface InsertSignalInput {
  account_id: string;
  buyer_id?: string | null;
  kind: SignalKind | string;
  source?: string | null;
  weight?: number | null;
  confidence?: number | null;
  payload_json?: string | null;
  evidence_url?: string | null;
  occurred_at?: string | null;
  expires_at?: string | null;
  created_by?: string | null;
}

export async function insertSignal(env: Env, input: InsertSignalInput): Promise<SignalRow> {
  const kind = assertSignalKind(input.kind);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const occurred = input.occurred_at ?? now;
  const rawW = (typeof input.weight === "number" && input.weight > 0) ? input.weight : (DEFAULT_WEIGHT as Record<string, number>)[kind] ?? 3;
  const weight = Math.min(10, Math.max(0.1, rawW));
  const confidence = (typeof input.confidence === "number" && input.confidence >= 0 && input.confidence <= 1) ? input.confidence : 1;
  // Validate buyer belongs to the same account, if provided.
  if (input.buyer_id) {
    const b = await env.DB.prepare(`SELECT account_id FROM buyers WHERE id = ?`).bind(input.buyer_id).first<{ account_id: string }>();
    if (!b) throw new Error("buyer_not_found");
    if (b.account_id !== input.account_id) throw new Error("buyer_account_mismatch");
  }
  // Reject malformed occurred_at outright so callers see the problem
  // instead of silently getting a near-zero contribution.
  if (input.occurred_at && !Number.isFinite(Date.parse(input.occurred_at))) {
    throw new Error("bad_occurred_at");
  }
  await env.DB.prepare(
    `INSERT INTO signals (id, account_id, buyer_id, kind, source, weight, confidence,
       payload_json, evidence_url, occurred_at, observed_at, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.account_id, input.buyer_id ?? null, kind, input.source ?? null, weight, confidence,
         input.payload_json ?? null, input.evidence_url ?? null, occurred, now,
         input.expires_at ?? null, input.created_by ?? null, now).run();
  const row = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first<SignalRow>();
  return row!;
}

export async function getSignal(env: Env, id: string): Promise<SignalRow | null> {
  const r = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first<SignalRow>();
  return r ?? null;
}

export async function updateSignal(env: Env, id: string, patch: Record<string, unknown>): Promise<SignalRow | null> {
  const cur = await getSignal(env, id);
  if (!cur) return null;
  const allowed = new Set(["weight","confidence","payload_json","evidence_url","occurred_at","expires_at","source"]);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return cur;
  binds.push(id);
  await env.DB.prepare(`UPDATE signals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return await getSignal(env, id);
}

export async function listSignals(env: Env, accountId: string, opts?: { limit?: number; kind?: string }): Promise<SignalRow[]> {
  const limit = Math.min(Math.max(1, opts?.limit ?? 100), 500);
  if (opts?.kind) {
    const r = await env.DB.prepare(`SELECT * FROM signals WHERE account_id = ? AND kind = ? ORDER BY occurred_at DESC LIMIT ?`).bind(accountId, opts.kind, limit).all<SignalRow>();
    return r.results ?? [];
  }
  const r = await env.DB.prepare(`SELECT * FROM signals WHERE account_id = ? ORDER BY occurred_at DESC LIMIT ?`).bind(accountId, limit).all<SignalRow>();
  return r.results ?? [];
}

export async function deleteSignal(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM signals WHERE id = ?`).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ----- account_tech
export async function listTech(env: Env, accountId: string): Promise<Array<Record<string, unknown>>> {
  const r = await env.DB.prepare(`SELECT * FROM account_tech WHERE account_id = ? ORDER BY last_detected_at DESC NULLS LAST, vendor ASC`).bind(accountId).all();
  return r.results ?? [];
}

// ----- history
export async function listHistory(env: Env, accountId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  const r = await env.DB.prepare(`SELECT * FROM account_history WHERE account_id = ? ORDER BY changed_at DESC LIMIT ?`).bind(accountId, Math.min(Math.max(1, limit), 500)).all();
  return r.results ?? [];
}

// ----- score recompute
export async function recomputeAccountScore(env: Env, accountId: string): Promise<{ intent: IntentResult; fit: number; account: number } | null> {
  const cur = await getAccount(env, accountId);
  if (!cur) return null;
  const sigs = await env.DB.prepare(`SELECT kind, weight, confidence, occurred_at FROM signals WHERE account_id = ?`).bind(accountId).all<{ kind: string; weight: number; confidence: number; occurred_at: string }>();
  const intent = computeIntent(sigs.results ?? []);
  const fit = cur.fit_score ?? 0;
  const account = blendAccountScore(intent.intent_score, fit);
  const breakdownPayload = JSON.stringify({ by_kind: intent.by_kind, raw_sum: intent.raw_sum, signal_count: intent.signal_count, newest_at: intent.newest_at });
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE accounts SET intent_score = ?, account_score = ?, intent_breakdown_json = ?, score_recomputed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(intent.intent_score, account, breakdownPayload, now, now, accountId).run();
  return { intent, fit, account };
}
