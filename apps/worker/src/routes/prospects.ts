// Task #44: prospect REST API.
//
// Mounted at three paths in src/index.ts:
//   /api/accounts   accountsRoute   list/create/update/delete + score + bulk-import + enrich
//   /api/buyers     buyersRoute
//   /api/signals    signalsRoute
//
// All behind the standard accessGuard. Score endpoints surface the
// intent breakdown so the dashboard's "Why this score?" expand can
// render component contributions.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  listAccounts, getAccount, insertAccount, updateAccount, deleteAccount,
  listBuyers, getBuyer, insertBuyer, updateBuyer, deleteBuyer,
  backfillBuyerRoles, countUnmatchedBuyerTitles,
  insertSignal, listSignals, getSignal, updateSignal, deleteSignal,
  listTech, listHistory, recomputeAccountScore,
  type AccountRow, type BuyerRow, type AccountListFilters,
} from "../prospects/repo";
import { SIGNAL_KINDS, isSignalKind } from "../prospects/signalKinds";
import { indexEntity } from "../ai/search_sync";
import { withEntityLock, ALLOWED_MERGE_FIELDS } from "../do/EntityLock";
import { ensureRoleTaxonomySeeded } from "../prospects/seedRoles";
import { rescoreEntity } from "../personas/rescore";
import { listMatchesForEntityWithDetails } from "../personas/repo";

function pickAllowed(table: "accounts" | "buyers", body: Record<string, unknown>): Record<string, unknown> {
  const allow = ALLOWED_MERGE_FIELDS[table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (allow.has(k)) out[k] = v;
  return out;
}

export const accountsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();
export const buyersRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();
export const signalsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// -------------------------------------------------------------- helpers
function parseJson<T>(s: string | null | undefined, fb: T): T {
  if (!s) return fb;
  try { return (JSON.parse(s) ?? fb) as T; } catch { return fb; }
}

function toListItem(r: AccountRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    logo_id: r.logo_id,
    industry: r.industry,
    industries: parseJson<string[]>(r.industries_json, []),
    size_band: r.size_band,
    employees: r.employees,
    hq_country_iso2: r.hq_country_iso2,
    hq_city: r.hq_city,
    funding_stage: r.funding_stage,
    status: r.status,
    owner_email: r.owner_email,
    fit_score: r.fit_score,
    intent_score: r.intent_score,
    account_score: r.account_score,
    intent_breakdown: parseJson<{ by_kind?: Array<{ kind: string; raw_contribution: number; count: number }> }>(r.intent_breakdown_json, {}),
    last_enriched_at: r.last_enriched_at,
    updated_at: r.updated_at,
  };
}

// ---------------------------------------------------------------- accounts
accountsRoute.get("/", async (c) => {
  const url = new URL(c.req.url);
  const f: AccountListFilters = {
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    industry: url.searchParams.get("industry") ?? undefined,
    size_band: url.searchParams.get("size_band") ?? undefined,
    country: url.searchParams.get("country") ?? undefined,
    owner_email: url.searchParams.get("owner_email") ?? undefined,
    funding_stage: url.searchParams.get("funding_stage") ?? undefined,
    has_signal_kind: url.searchParams.get("has_signal_kind") ?? undefined,
    vendor: url.searchParams.get("vendor") ?? undefined,
  };
  const numIfFinite = (raw: string | null): number | undefined => {
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  f.min_intent = numIfFinite(url.searchParams.get("min_intent"));
  f.min_fit = numIfFinite(url.searchParams.get("min_fit"));
  f.min_account_score = numIfFinite(url.searchParams.get("min_account_score"));
  f.signal_within_days = numIfFinite(url.searchParams.get("signal_within_days"));
  f.limit = numIfFinite(url.searchParams.get("limit"));
  f.offset = numIfFinite(url.searchParams.get("offset"));
  const sort = url.searchParams.get("sort");
  if (sort === "intent_score" || sort === "fit_score" || sort === "account_score" || sort === "name" || sort === "updated_at") {
    f.sort = sort;
  }
  const r = await listAccounts(c.env, f);
  return c.json({
    items: r.items.map(toListItem),
    nextOffset: r.nextOffset,
    aggregates: r.aggregates,
  });
});

accountsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getAccount(c.env, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const [buyers, signals, tech, history] = await Promise.all([
    listBuyers(c.env, id),
    listSignals(c.env, id, { limit: 200 }),
    listTech(c.env, id),
    listHistory(c.env, id, 100),
  ]);
  return c.json({
    account: row,
    industries: parseJson<string[]>(row.industries_json, []),
    intent_breakdown: parseJson<unknown>(row.intent_breakdown_json, null),
    fit_breakdown: parseJson<unknown>(row.fit_breakdown_json, null),
    buyers, signals, tech, history,
  });
});

accountsRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<AccountRow> | null;
  if (!body || !body.name || typeof body.name !== "string") return c.json({ error: "bad_request:name" }, 400);
  const row = await insertAccount(c.env, body as Partial<AccountRow> & { name: string }, c.get("email"));
  // Fire-and-forget vectorize + AI search.
  c.executionCtx.waitUntil(syncAccountAi(c.env, row));
  // Task #46: score the new account against every active persona.
  c.executionCtx.waitUntil(rescoreEntity(c.env, "account", row.id).catch((e) => console.warn("persona rescore (account create) failed", (e as Error).message)));
  return c.json({ account: row }, 201);
});

accountsRoute.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Partial<AccountRow> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  // Route the field-level merge through the EntityLock DO so two
  // concurrent updates (manual edit + crawler enrichment) cannot race.
  // When the binding is absent (local dev) we fall through to the direct
  // repo path so the route still works.
  const safeFields = pickAllowed("accounts", body as Record<string, unknown>);
  // Snapshot BEFORE the DO merge so updateAccount() can diff against the
  // real pre-merge values when writing account_history rows. Without this
  // snapshot, the DO merge writes new values first and the history diff
  // would silently see no changes.
  const snapshot = await getAccount(c.env, id);
  if (!snapshot) return c.json({ error: "not_found" }, 404);
  const lockResp = await withEntityLock(c.env, "account", id, "merge_account", {
    id, fields: safeFields, history_source: "api",
  });
  if (lockResp && !lockResp.ok) {
    console.warn("EntityLock merge_account failed", lockResp.status);
  }
  const row = await updateAccount(c.env, id, safeFields as Partial<AccountRow>, c.get("email"), snapshot);
  if (!row) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(syncAccountAi(c.env, row));
  // Task #46: re-score this account against every active persona so
  // dashboards + persona_matches reflect the edit. Cheap (no embedding)
  // and runs in the request tail.
  c.executionCtx.waitUntil(rescoreEntity(c.env, "account", id).catch((e) => console.warn("persona rescore (account update) failed", (e as Error).message)));
  return c.json({ account: row });
});

accountsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await deleteAccount(c.env, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  // Task #46: drop persona_matches rows that pointed at this account.
  c.executionCtx.waitUntil(c.env.DB.prepare(`DELETE FROM persona_matches WHERE entity_kind = 'account' AND entity_id = ?`).bind(id).run().then(() => undefined).catch((e) => console.warn("persona match cleanup (account delete) failed", (e as Error).message)));
  return c.json({ ok: true });
});

// Task #58: surface persona-fit on the account detail page. Returns
// every active persona that scored this account >= 50, sorted desc,
// with the cached AI explanation so the panel can render an
// expand/collapse rationale next to each score.
accountsRoute.get("/:id/personas", async (c) => {
  const id = c.req.param("id");
  const exists = await getAccount(c.env, id);
  if (!exists) return c.json({ error: "not_found" }, 404);
  const url = new URL(c.req.url);
  const minScore = Number(url.searchParams.get("min_score"));
  const items = await listMatchesForEntityWithDetails(c.env, "account", id, {
    minScore: Number.isFinite(minScore) ? minScore : 50,
  });
  return c.json({ entity_kind: "account", entity_id: id, items });
});

accountsRoute.get("/:id/score", async (c) => {
  const id = c.req.param("id");
  const r = await recomputeAccountScore(c.env, id);
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({
    account_id: id,
    intent_score: r.intent.intent_score,
    fit_score: r.fit.fit_score,
    account_score: r.account,
    intent_breakdown: { by_kind: r.intent.by_kind, raw_sum: r.intent.raw_sum, signal_count: r.intent.signal_count, newest_at: r.intent.newest_at },
    fit_breakdown: { icp_id: r.fit.icp_id, icp_name: r.fit.icp_name, components: r.fit.components, computed_at: r.fit.computed_at },
    formula: { intent_blend: 0.6, fit_blend: 0.4, half_life_days: 30, scale: 25 },
  });
});

accountsRoute.post("/:id/signals", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { kind?: string; weight?: number; confidence?: number; payload?: unknown; evidence_url?: string; occurred_at?: string; source?: string; buyer_id?: string } | null;
  if (!body?.kind || !isSignalKind(body.kind)) return c.json({ error: "bad_kind", allowed: SIGNAL_KINDS }, 400);
  const exists = await getAccount(c.env, id);
  if (!exists) return c.json({ error: "not_found" }, 404);
  const sig = await insertSignal(c.env, {
    account_id: id, buyer_id: body.buyer_id ?? null,
    kind: body.kind, source: body.source ?? "manual",
    weight: body.weight ?? null, confidence: body.confidence ?? null,
    payload_json: body.payload != null ? JSON.stringify(body.payload) : null,
    evidence_url: body.evidence_url ?? null,
    occurred_at: body.occurred_at ?? null,
    created_by: c.get("email"),
  });
  const score = await recomputeAccountScore(c.env, id);
  // Task #46: every new signal can shift signal_fit on every persona
  // that targets this account.
  c.executionCtx.waitUntil(rescoreEntity(c.env, "account", id).catch((e) => console.warn("persona rescore (signal insert) failed", (e as Error).message)));
  return c.json({ signal: sig, score }, 201);
});

accountsRoute.post("/:id/enrich", async (c) => {
  const id = c.req.param("id");
  const row = await getAccount(c.env, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  let workflowId: string | null = null;
  if (c.env.WF_ENRICH_ACCOUNT) {
    try {
      const r = await c.env.WF_ENRICH_ACCOUNT.create({ params: { accountId: id } });
      workflowId = r.id;
    } catch (e) {
      console.warn("WF_ENRICH_ACCOUNT.create failed", (e as Error).message);
    }
  }
  await c.env.DB.prepare(`UPDATE accounts SET last_enriched_at = ?, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), new Date().toISOString(), id).run();
  return c.json({ ok: true, workflowId, dispatched: !!workflowId });
});

// Bulk import (mirrors the firms importer shape): { rows: [{ name, domain, ... }] }.
// Returns counts only; per-row errors are logged.
// Admin one-shot trigger so first-run / fresh environments can populate
// the role taxonomy immediately instead of waiting for the nightly cron's
// "ensure" check. Idempotent: ensureRoleTaxonomySeeded only inserts rows
// for slugs not already present.
accountsRoute.post("/_seed-roles", async (c) => {
  await ensureRoleTaxonomySeeded(c.env);
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM role_taxonomy`).first<{ n: number }>();
  return c.json({ ok: true, total: row?.n ?? 0 });
});

accountsRoute.post("/import", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rows?: Array<Partial<AccountRow>> } | null;
  const rows = (body?.rows ?? []).filter((r) => r && typeof r.name === "string" && r.name.trim());
  if (!rows.length) return c.json({ error: "empty_rows" }, 400);
  const ids: string[] = [];
  let failed = 0;
  for (const r of rows.slice(0, 1000)) {
    try {
      const row = await insertAccount(c.env, r as Partial<AccountRow> & { name: string }, c.get("email"));
      ids.push(row.id);
      c.executionCtx.waitUntil(syncAccountAi(c.env, row));
    } catch (e) {
      failed += 1;
      console.warn("import account failed", r.name, (e as Error).message);
    }
  }
  return c.json({ inserted: ids.length, failed, ids });
});

// ---------------------------------------------------------------- buyers
buyersRoute.get("/", async (c) => {
  const accountId = new URL(c.req.url).searchParams.get("account_id");
  if (!accountId) return c.json({ error: "missing_account_id" }, 400);
  return c.json({ items: await listBuyers(c.env, accountId) });
});

// Task #52: peek at unclassified titles so an operator can see how many
// buyer rows still need either an alias added to the taxonomy or a
// manual role_slug pinning. Registered before `/:id` so Hono doesn't
// route `_unmatched-titles` into the param matcher.
buyersRoute.get("/_unmatched-titles", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "5000")), 10_000);
  const r = await countUnmatchedBuyerTitles(c.env, limit);
  return c.json(r);
});

buyersRoute.get("/:id", async (c) => {
  const r = await getBuyer(c.env, c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ buyer: r });
});

// Task #58: persona-fit panel for the buyer detail page. Same shape as
// the account variant but scoped to buyer-kind personas via the
// entity_kind filter on persona_matches.
buyersRoute.get("/:id/personas", async (c) => {
  const id = c.req.param("id");
  const exists = await getBuyer(c.env, id);
  if (!exists) return c.json({ error: "not_found" }, 404);
  const url = new URL(c.req.url);
  const minScore = Number(url.searchParams.get("min_score"));
  const items = await listMatchesForEntityWithDetails(c.env, "buyer", id, {
    minScore: Number.isFinite(minScore) ? minScore : 50,
  });
  return c.json({ entity_kind: "buyer", entity_id: id, items });
});

buyersRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<BuyerRow> | null;
  if (!body?.account_id || typeof body.account_id !== "string") return c.json({ error: "missing_account_id" }, 400);
  const acct = await getAccount(c.env, body.account_id);
  if (!acct) return c.json({ error: "account_not_found" }, 404);
  const row = await insertBuyer(c.env, body as Partial<BuyerRow> & { account_id: string });
  // Task #46: score the new buyer + parent account.
  c.executionCtx.waitUntil((async () => {
    try { await rescoreEntity(c.env, "buyer", row.id); await rescoreEntity(c.env, "account", row.account_id); }
    catch (e) { console.warn("persona rescore (buyer create) failed", (e as Error).message); }
  })());
  return c.json({ buyer: row }, 201);
});

buyersRoute.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Partial<BuyerRow> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  // Serialize concurrent buyer merges (e.g. crawler + manual edit) via DO.
  const safeFields = pickAllowed("buyers", body as Record<string, unknown>);
  const lockResp = await withEntityLock(c.env, "buyer", id, "merge_buyer", {
    id, fields: safeFields, history_source: "api",
  });
  if (lockResp && !lockResp.ok) {
    console.warn("EntityLock merge_buyer failed", lockResp.status);
  }
  const r = await updateBuyer(c.env, id, safeFields as Partial<BuyerRow>);
  if (!r) return c.json({ error: "not_found" }, 404);
  // Task #46: re-score this buyer (and its parent account) against every
  // active persona. Buyer edits feed buyer-kind personas directly and
  // can also lift the parent account's buyer_fit component.
  c.executionCtx.waitUntil((async () => {
    try { await rescoreEntity(c.env, "buyer", id); if (r.account_id) await rescoreEntity(c.env, "account", r.account_id); }
    catch (e) { console.warn("persona rescore (buyer update) failed", (e as Error).message); }
  })());
  return c.json({ buyer: r });
});

buyersRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const cur = await getBuyer(c.env, id);
  const ok = await deleteBuyer(c.env, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  // Task #46: drop the buyer's persona_matches rows + re-score parent
  // account (its buyer_fit may have just shifted).
  c.executionCtx.waitUntil((async () => {
    try {
      await c.env.DB.prepare(`DELETE FROM persona_matches WHERE entity_kind = 'buyer' AND entity_id = ?`).bind(id).run();
      if (cur?.account_id) await rescoreEntity(c.env, "account", cur.account_id);
    } catch (e) { console.warn("persona cleanup (buyer delete) failed", (e as Error).message); }
  })());
  return c.json({ ok: true });
});

// Task #52: one-shot backfill of buyer.role_slug / seniority / department /
// is_decision_maker for legacy rows whose `title` predates the classifier.
// Idempotent; pass ?force=1 to reclassify rows that already have role_slug.
buyersRoute.post("/_backfill-roles", async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "1000")), 10_000);
  const force = url.searchParams.get("force") === "1";
  const r = await backfillBuyerRoles(c.env, { limit, force });
  return c.json({ ok: true, ...r });
});

// ---------------------------------------------------------------- signals
signalsRoute.get("/", async (c) => {
  const url = new URL(c.req.url);
  const accountId = url.searchParams.get("account_id");
  if (!accountId) return c.json({ error: "missing_account_id" }, 400);
  const kind = url.searchParams.get("kind") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? "100");
  return c.json({ items: await listSignals(c.env, accountId, { kind, limit: Number.isFinite(limit) ? limit : 100 }) });
});

signalsRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { account_id?: string; kind?: string; weight?: number; confidence?: number; payload?: unknown; evidence_url?: string; occurred_at?: string; source?: string; buyer_id?: string } | null;
  if (!body?.account_id) return c.json({ error: "missing_account_id" }, 400);
  if (!body?.kind || !isSignalKind(body.kind)) return c.json({ error: "bad_kind", allowed: SIGNAL_KINDS }, 400);
  const acct = await getAccount(c.env, body.account_id);
  if (!acct) return c.json({ error: "account_not_found" }, 404);
  const sig = await insertSignal(c.env, {
    account_id: body.account_id, buyer_id: body.buyer_id ?? null,
    kind: body.kind, source: body.source ?? "manual",
    weight: body.weight ?? null, confidence: body.confidence ?? null,
    payload_json: body.payload != null ? JSON.stringify(body.payload) : null,
    evidence_url: body.evidence_url ?? null,
    occurred_at: body.occurred_at ?? null,
    created_by: c.get("email"),
  });
  const score = await recomputeAccountScore(c.env, body.account_id);
  // Task #46: see /api/accounts/:id/signals — same trigger.
  c.executionCtx.waitUntil(rescoreEntity(c.env, "account", body.account_id).catch((e) => console.warn("persona rescore (signal insert) failed", (e as Error).message)));
  return c.json({ signal: sig, score }, 201);
});

// IMPORTANT: register the static "/kinds" route BEFORE the "/:id" param
// route. Hono matches in registration order; if "/:id" comes first it
// captures "kinds" and the dashboard's signal-kind dropdown breaks.
signalsRoute.get("/kinds", (c) => c.json({ kinds: SIGNAL_KINDS }));

signalsRoute.get("/:id", async (c) => {
  const r = await getSignal(c.env, c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ signal: r });
});

signalsRoute.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { weight?: number; confidence?: number; payload?: unknown; evidence_url?: string; occurred_at?: string; source?: string; expires_at?: string } | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  if (body.occurred_at && !Number.isFinite(Date.parse(body.occurred_at))) return c.json({ error: "bad_occurred_at" }, 400);
  const patch: Record<string, unknown> = {};
  if (typeof body.weight === "number") patch.weight = Math.min(10, Math.max(0.1, body.weight));
  if (typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1) patch.confidence = body.confidence;
  if (body.evidence_url !== undefined) patch.evidence_url = body.evidence_url;
  if (body.occurred_at !== undefined) patch.occurred_at = body.occurred_at;
  if (body.expires_at !== undefined) patch.expires_at = body.expires_at;
  if (body.source !== undefined) patch.source = body.source;
  if (body.payload !== undefined) patch.payload_json = body.payload != null ? JSON.stringify(body.payload) : null;
  const updated = await updateSignal(c.env, id, patch);
  if (!updated) return c.json({ error: "not_found" }, 404);
  const score = await recomputeAccountScore(c.env, updated.account_id);
  c.executionCtx.waitUntil(rescoreEntity(c.env, "account", updated.account_id).catch((e) => console.warn("persona rescore (signal edit) failed", (e as Error).message)));
  return c.json({ signal: updated, score });
});

signalsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sig = await c.env.DB.prepare(`SELECT account_id FROM signals WHERE id = ?`).bind(id).first<{ account_id: string }>();
  const ok = await deleteSignal(c.env, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  if (sig) {
    await recomputeAccountScore(c.env, sig.account_id);
    // Task #46: signal removal can lower signal_fit on every persona
    // that targets this account.
    c.executionCtx.waitUntil(rescoreEntity(c.env, "account", sig.account_id).catch((e) => console.warn("persona rescore (signal delete) failed", (e as Error).message)));
  }
  return c.json({ ok: true });
});

// ----------------------------------------------------------- ai sync helper
//
// Vectorize: accounts have their own index (`VEC_ACCOUNTS` / axal-accounts-768)
// rather than going through the leads/firms/companies switch in
// `dedupe/vector.ts`. This keeps the prospect-discovery search semantically
// separate from the investor/portfolio search.
//
// AI Search: routed to the `axal-accounts` namespace (handled inside
// indexEntity via SearchDoc.namespace), distinct from the `axal-profiles`
// namespace used by the investor side.
async function syncAccountAi(env: Env, row: AccountRow): Promise<void> {
  try {
    if (env.VEC_ACCOUNTS) {
      const text = [row.name, row.industry, row.description, row.hq_city, row.hq_country_iso2].filter(Boolean).join(" | ");
      const { aiEmbed } = await import("../ai/extract");
      const vec = await aiEmbed(env, text);
      if (vec) {
        await env.VEC_ACCOUNTS.upsert([{ id: row.id, values: vec, metadata: { name: row.name, industry: row.industry ?? "", domain: row.domain ?? "" } }]);
        await env.DB.prepare(`UPDATE accounts SET embedding_dim = ?, embedded_at = ? WHERE id = ?`).bind(vec.length, new Date().toISOString(), row.id).run();
      }
    }
    await indexEntity(env, {
      id: row.id, type: "account", namespace: "axal-accounts",
      title: row.name,
      body: [row.name, row.industry, row.description, row.hq_city, row.hq_country_iso2].filter(Boolean).join(" — "),
      url: row.website ?? undefined,
    });
  } catch (e) {
    console.warn("syncAccountAi failed", row.id, (e as Error).message);
  }
}
