// Task #2: bulk operations across list pages. Every endpoint is mounted
// under /api/bulk and gated by accessGuard (single allowlisted operator
// today). Each per-entity mutation writes one `bulk_operation_audit`
// row keyed by a per-call `operation_id` so /api/bulk/undo can replay
// the inverse within 24h.
//
// Routes:
//   POST /api/bulk/assign-role     {entity_ids, role, remove?}
//   POST /api/bulk/add-tag         {entity_ids, tag_name|tag_slug, taxonomy?}
//   POST /api/bulk/enrich          {entity_ids}                  → enqueue per-entity
//   POST /api/bulk/merge           {canonical_id, merge_ids[]}   → fan-out to merge helper
//   POST /api/bulk/delete          {entity_ids}                  → soft delete
//   POST /api/bulk/export          {entity_ids}                  → streamed CSV
//   POST /api/bulk/undo/:opId      replay before_json snapshots
//
// Confirmation contract: any op affecting >100 entities requires
// `confirmed:true`; >1000 additionally requires
// `confirmation_token:'CONFIRM'`. Hard cap of 5000 entities per call.
//
// Idempotency: a non-empty `Idempotency-Key` header maps (email, key)
// → operation_id. The first call records the mapping; repeats return
// the original operation_id and never re-apply.

import { Hono } from "hono";
import type { Env } from "../types";
import type { EntityRole } from "../entities/model";
import { addTag } from "../entities/tags";
import { addRole } from "../entities/roles";
import { mergeWithCanonical } from "../entities/merge";
import type { Taxonomy } from "../entities/model";

const HARD_CAP = 5000;
const CONFIRM_THRESHOLD = 100;
const STRICT_CONFIRM_THRESHOLD = 1000;
const STRICT_CONFIRM_TOKEN = "CONFIRM";

const ALLOWED_ROLES: ReadonlySet<EntityRole> = new Set<EntityRole>([
  "investor", "investor_firm", "angel", "vc", "gp", "lp",
  "founder", "operator", "executive", "board_member",
  "advisor", "employee", "customer", "prospect", "buyer", "lead",
  "partner", "firm", "fund", "accelerator", "company",
  "account", "school",
]);

type BulkAction = "assign_role" | "add_tag" | "enrich" | "merge" | "delete" | "export";

interface BulkBody {
  entity_ids?: unknown;
  confirmed?: unknown;
  confirmation_token?: unknown;
  role?: unknown;
  remove?: unknown;
  tag_name?: unknown;
  tag_slug?: unknown;
  taxonomy?: unknown;
  canonical_id?: unknown;
  merge_ids?: unknown;
}

export const bulk = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function ulid(): string {
  // Lexically-sortable id good enough for an operation_id. Crockford
  // base32 of a 48-bit timestamp + 80 bits of randomness.
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${tsHex}${rand}`.toUpperCase();
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

interface ConfirmationCheck {
  ok: boolean;
  body?: Record<string, unknown>;
  status?: 409;
}

function checkConfirmation(action: BulkAction, ids: string[], body: BulkBody): ConfirmationCheck {
  const n = ids.length;
  if (n > HARD_CAP) {
    return {
      ok: false, status: 409,
      body: { error: "too_many", message: `max ${HARD_CAP} entities per bulk call`, affected_count: n },
    };
  }
  if (n > STRICT_CONFIRM_THRESHOLD) {
    if (body.confirmation_token !== STRICT_CONFIRM_TOKEN) {
      return {
        ok: false, status: 409,
        body: {
          error: "requires_confirmation",
          requires_confirmation: true,
          requires_strict_confirmation: true,
          affected_count: n,
          action,
          confirmation_token_required: STRICT_CONFIRM_TOKEN,
          sample: ids.slice(0, 5),
        },
      };
    }
  }
  if (n > CONFIRM_THRESHOLD) {
    if (body.confirmed !== true) {
      return {
        ok: false, status: 409,
        body: {
          error: "requires_confirmation",
          requires_confirmation: true,
          affected_count: n,
          action,
          sample: ids.slice(0, 5),
        },
      };
    }
  }
  return { ok: true };
}

// Resolve raw caller ids → u_entities.id. We accept either a u_entities.id
// directly or a legacy id (leads/firms/companies/accounts/buyers) which is
// translated via entity_legacy_map. Returned `resolution` maps each
// original input id to its u_entities.id (when found). Visible = those
// resolved ids whose u_entities row exists and isn't soft_deleted.
// Owner-isolation: drop any resolved entity that the caller doesn't own
// via the legacy owner_email columns (leads.owner_email,
// accounts.owner_email). u_entities itself has no owner column, so an
// entity that has no legacy lead/account row passes through (it was
// produced by the platform, not by a per-user import). Today there is a
// single allowlisted operator, so this is a forward-compatibility net;
// once multi-operator lands the helper is the single chokepoint that
// has to be tightened.
async function filterByOwner(env: Env, email: string, entityIds: string[]): Promise<Set<string>> {
  if (!entityIds.length) return new Set();
  const ph = entityIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT m.entity_id, COALESCE(l.owner_email, a.owner_email) AS owner_email
       FROM entity_legacy_map m
       LEFT JOIN leads l    ON m.legacy_table = 'leads'    AND l.id = m.legacy_id
       LEFT JOIN accounts a ON m.legacy_table = 'accounts' AND a.id = m.legacy_id
      WHERE m.entity_id IN (${ph})`,
  ).bind(...entityIds).all<{ entity_id: string; owner_email: string | null }>();
  // Group by entity_id; entity is dropped only if *every* legacy row
  // has a non-null owner that doesn't match the caller. If at least
  // one legacy mapping is owned-by-caller OR has no owner at all, the
  // entity is visible.
  const ownerByEntity = new Map<string, { hasUnowned: boolean; ownedByCaller: boolean; hasAnyForeign: boolean }>();
  for (const r of (rows.results ?? [])) {
    const cur = ownerByEntity.get(r.entity_id) ?? { hasUnowned: false, ownedByCaller: false, hasAnyForeign: false };
    if (r.owner_email == null) cur.hasUnowned = true;
    else if (r.owner_email === email) cur.ownedByCaller = true;
    else cur.hasAnyForeign = true;
    ownerByEntity.set(r.entity_id, cur);
  }
  const visible = new Set<string>();
  for (const id of entityIds) {
    const o = ownerByEntity.get(id);
    if (!o) { visible.add(id); continue; }              // no legacy mapping → modern row, visible
    if (o.ownedByCaller || o.hasUnowned) visible.add(id);
    // else: entity is owned exclusively by another operator → drop
  }
  return visible;
}

async function resolveAndFilter(env: Env, ids: string[]): Promise<{
  visible: string[];           // u_entities.id list (deduplicated, ordered by first appearance)
  dropped: string[];           // original input ids that couldn't be resolved or are soft-deleted
  inputToEntity: Map<string, string>; // original id → entity_id
}> {
  if (!ids.length) return { visible: [], dropped: [], inputToEntity: new Map() };
  const placeholders = ids.map(() => "?").join(",");
  // First pass: direct entity matches.
  const direct = await env.DB.prepare(
    `SELECT id FROM u_entities WHERE id IN (${placeholders}) AND status != 'soft_deleted'`,
  ).bind(...ids).all<{ id: string }>();
  const directIds = new Set((direct.results ?? []).map((r) => r.id));

  // Second pass: legacy lookup for the remainder.
  const remaining = ids.filter((x) => !directIds.has(x));
  const legacyMap = new Map<string, string>(); // legacy_id → entity_id
  if (remaining.length) {
    const ph2 = remaining.map(() => "?").join(",");
    const legRes = await env.DB.prepare(
      `SELECT m.legacy_id, m.entity_id
         FROM entity_legacy_map m
         JOIN u_entities e ON e.id = m.entity_id
        WHERE m.legacy_id IN (${ph2}) AND e.status != 'soft_deleted'`,
    ).bind(...remaining).all<{ legacy_id: string; entity_id: string }>();
    for (const row of (legRes.results ?? [])) {
      if (!legacyMap.has(row.legacy_id)) legacyMap.set(row.legacy_id, row.entity_id);
    }
  }

  const inputToEntity = new Map<string, string>();
  const visibleSet = new Set<string>();
  const candidates: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) {
    let resolved: string | undefined;
    if (directIds.has(id)) resolved = id;
    else resolved = legacyMap.get(id);
    if (!resolved) { dropped.push(id); continue; }
    inputToEntity.set(id, resolved);
    if (!visibleSet.has(resolved)) {
      visibleSet.add(resolved);
      candidates.push(resolved);
    }
  }
  return { visible: candidates, dropped, inputToEntity };
}

// Resolve + apply owner-isolation. All bulk endpoints go through this
// so foreign-owned rows are silently dropped (and reported under
// `dropped`) per the spec.
async function resolveScoped(env: Env, email: string, ids: string[]): Promise<{
  visible: string[]; dropped: string[]; inputToEntity: Map<string, string>;
}> {
  const r = await resolveAndFilter(env, ids);
  if (!r.visible.length) return r;
  const owned = await filterByOwner(env, email, r.visible);
  const visible = r.visible.filter((x) => owned.has(x));
  if (visible.length === r.visible.length) return r;
  const droppedExtra: string[] = [];
  for (const [input, ent] of r.inputToEntity.entries()) {
    if (!owned.has(ent) && !r.dropped.includes(input)) droppedExtra.push(input);
  }
  return { visible, dropped: r.dropped.concat(droppedExtra), inputToEntity: r.inputToEntity };
}

interface IdempotencyClaim { operation_id: string; reused: boolean; action_mismatch?: BulkAction; }

// Atomic claim: INSERT OR IGNORE first, then SELECT. If the SELECT returns
// the *same* opId we just tried to insert, this caller is the first writer.
// Otherwise the row was already present — return the original opId and let
// the caller short-circuit without re-applying side-effects. PK is
// (email, key), so an action mismatch is surfaced explicitly via 409.
async function claimIdempotency(env: Env, email: string, key: string | null, candidateOpId: string, action: BulkAction): Promise<IdempotencyClaim | null> {
  if (!key) return null;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO bulk_idempotency_keys (performed_by_email, idempotency_key, operation_id, action) VALUES (?, ?, ?, ?)`,
    ).bind(email, key, candidateOpId, action).run();
  } catch (e) {
    console.warn("claimIdempotency insert failed", (e as Error).message);
  }
  const r = await env.DB.prepare(
    `SELECT operation_id, action FROM bulk_idempotency_keys WHERE performed_by_email = ? AND idempotency_key = ?`,
  ).bind(email, key).first<{ operation_id: string; action: BulkAction }>();
  if (!r) return { operation_id: candidateOpId, reused: false };
  if (r.action !== action) return { operation_id: r.operation_id, reused: true, action_mismatch: r.action };
  return { operation_id: r.operation_id, reused: r.operation_id !== candidateOpId };
}

// Returns the prepared INSERT for the audit row without running it, so it
// can participate in a D1.batch() alongside the per-entity mutation
// statement and give us per-entity transactionality.
function auditStmt(
  env: Env, opId: string, action: BulkAction, entityId: string,
  before: unknown, after: unknown, email: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO bulk_operation_audit (operation_id, action, entity_id, before_json, after_json, performed_by_email)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    opId, action, entityId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    email,
  );
}

async function writeAudit(
  env: Env, opId: string, action: BulkAction, entityId: string,
  before: unknown, after: unknown, email: string,
): Promise<void> {
  await auditStmt(env, opId, action, entityId, before, after, email).run();
}

// --------------------------- assign-role ---------------------------

bulk.post("/assign-role", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const ids = asStringArray(body.entity_ids);
  const role = String(body.role ?? "").trim() as EntityRole;
  const remove = body.remove === true;
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  if (!ALLOWED_ROLES.has(role)) return c.json({ error: "bad_request", message: `invalid role: ${role}` }, 400);
  const conf = checkConfirmation("assign_role", ids, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "assign_role");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true }, 200);
  }

  const { visible, dropped } = await resolveScoped(c.env, email, ids);
  let mutated = 0;
  for (const entityId of visible) {
    const before = await c.env.DB.prepare(
      `SELECT id, role, is_primary, source FROM entity_roles WHERE entity_id = ? AND role = ?`,
    ).bind(entityId, role).first<{ id: number; role: string; is_primary: number; source: string | null }>();
    if (remove) {
      if (!before) continue;
      // Per-entity atomicity, audit-BEFORE-mutation. If the batch
      // half-applies, the audit row is the surviving record.
      await c.env.DB.batch([
        auditStmt(c.env, opId, "assign_role", entityId,
          { exists: true, role, source: before.source }, { exists: false, role }, email),
        c.env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ? AND role = ?`).bind(entityId, role),
      ]);
      mutated += 1;
    } else {
      if (before) continue; // already present — no-op, no audit row.
      // Audit before the role write so that a partial failure still
      // leaves an undo-able audit row. addRole is idempotent.
      await auditStmt(c.env, opId, "assign_role", entityId,
        { exists: false, role }, { exists: true, role, source: "bulk" }, email).run();
      await addRole(c.env, entityId, role, { source: "bulk" });
      mutated += 1;
    }
  }
  return c.json({ ok: true, operation_id: opId, affected: mutated, dropped, role, removed: remove }, 200);
});

// --------------------------- add-tag ---------------------------

bulk.post("/add-tag", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const ids = asStringArray(body.entity_ids);
  const taxonomy = (typeof body.taxonomy === "string" && body.taxonomy.trim()) ? body.taxonomy.trim() : "tag";
  const slug = String(body.tag_slug ?? body.tag_name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  if (!slug) return c.json({ error: "bad_request", message: "tag_name or tag_slug required" }, 400);
  const conf = checkConfirmation("add_tag", ids, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "add_tag");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true }, 200);
  }

  const { visible, dropped } = await resolveScoped(c.env, email, ids);
  let mutated = 0;
  for (const entityId of visible) {
    const existed = await c.env.DB.prepare(
      `SELECT id FROM entity_tags WHERE entity_id = ? AND taxonomy = ? AND slug = ?`,
    ).bind(entityId, taxonomy, slug).first<{ id: number }>();
    if (existed) continue;
    // Audit before mutation (addTag is idempotent on conflict).
    await writeAudit(c.env, opId, "add_tag", entityId,
      { exists: false, taxonomy, slug }, { exists: true, taxonomy, slug }, email);
    await addTag(c.env, { entity_id: entityId, taxonomy: taxonomy as Taxonomy, slug, source: "bulk" });
    mutated += 1;
  }
  return c.json({ ok: true, operation_id: opId, affected: mutated, dropped, taxonomy, slug }, 200);
});

// --------------------------- enrich ---------------------------

bulk.post("/enrich", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const ids = asStringArray(body.entity_ids);
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  const conf = checkConfirmation("enrich", ids, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "enrich");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true }, 200);
  }

  const { visible, dropped } = await resolveScoped(c.env, email, ids);

  // 7-day cap: skip any entity that was already part of a successful
  // `enrich` bulk dispatch in the last 7 days (per audit). The cap is
  // worker-side so it survives retries and idempotency-key collisions.
  let skippedRateLimited: string[] = [];
  let enrichTargets: string[] = visible;
  if (visible.length) {
    const ph = visible.map(() => "?").join(",");
    const recent = await c.env.DB.prepare(
      `SELECT DISTINCT entity_id
         FROM bulk_operation_audit
        WHERE action = 'enrich'
          AND entity_id IN (${ph})
          AND performed_at > datetime('now','-7 days')
          AND undone_at IS NULL`,
    ).bind(...visible).all<{ entity_id: string }>();
    const blocked = new Set((recent.results ?? []).map((r) => r.entity_id));
    skippedRateLimited = visible.filter((x) => blocked.has(x));
    enrichTargets = visible.filter((x) => !blocked.has(x));
  }

  let enqueued = 0;
  const filler = c.env.WF_PROFILE_FILLER as { create: (o: { params: Record<string, unknown> }) => Promise<{ id: string }> } | undefined;
  for (const entityId of enrichTargets) {
    let workflowId: string | null = null;
    if (filler && typeof filler.create === "function") {
      try {
        const wf = await filler.create({ params: { entity_id: entityId, source: "bulk", operation_id: opId } });
        workflowId = wf.id;
        enqueued += 1;
      } catch (e) {
        console.warn("bulk.enrich dispatch failed", entityId, (e as Error).message);
      }
    }
    await writeAudit(c.env, opId, "enrich", entityId,
      { dispatched: false }, { dispatched: workflowId !== null, workflow_id: workflowId }, email);
  }
  return c.json({
    ok: true, operation_id: opId, dispatched: enqueued,
    requested: visible.length, dropped,
    skipped_rate_limited: skippedRateLimited,
    note: filler ? null : "filler workflow not bound; audit-only run",
  }, 202);
});

// --------------------------- merge ---------------------------

bulk.post("/merge", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const canonicalId = typeof body.canonical_id === "string" ? body.canonical_id.trim() : "";
  const mergeIds = asStringArray(body.merge_ids).filter((x) => x !== canonicalId);
  if (!canonicalId || !mergeIds.length) {
    return c.json({ error: "bad_request", message: "canonical_id and merge_ids required" }, 400);
  }
  const conf = checkConfirmation("merge", mergeIds, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "merge");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true }, 200);
  }

  const { visible: visibleMerge, dropped, inputToEntity } = await resolveScoped(c.env, email, [canonicalId, ...mergeIds]);
  const canonicalResolved = inputToEntity.get(canonicalId);
  if (!canonicalResolved || !visibleMerge.includes(canonicalResolved)) {
    return c.json({ error: "not_found", message: "canonical_id not visible" }, 404);
  }
  const results: Array<{ secondary: string; ok: boolean; error?: string }> = [];
  for (const sid of visibleMerge.filter((x) => x !== canonicalResolved)) {
    try {
      const r = await mergeWithCanonical(c.env, canonicalResolved, sid);
      await writeAudit(c.env, opId, "merge", sid,
        { status: "active" }, { status: "merged", merged_into: canonicalResolved, result: r }, email);
      results.push({ secondary: sid, ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      console.warn("bulk.merge failed", sid, msg);
      results.push({ secondary: sid, ok: false, error: msg });
    }
  }
  return c.json({ ok: true, operation_id: opId, canonical_id: canonicalResolved, results, dropped }, 200);
});

// --------------------------- delete (soft) ---------------------------

bulk.post("/delete", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const ids = asStringArray(body.entity_ids);
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  const conf = checkConfirmation("delete", ids, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "delete");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true }, 200);
  }

  const { visible, dropped } = await resolveScoped(c.env, email, ids);
  let mutated = 0;
  for (const entityId of visible) {
    const before = await c.env.DB.prepare(`SELECT status FROM u_entities WHERE id = ?`)
      .bind(entityId).first<{ status: string }>();
    if (!before || before.status === "soft_deleted") continue;
    // Per-entity atomicity, audit BEFORE mutation in one D1.batch().
    await c.env.DB.batch([
      auditStmt(c.env, opId, "delete", entityId,
        { status: before.status }, { status: "soft_deleted" }, email),
      c.env.DB.prepare(`UPDATE u_entities SET status = 'soft_deleted', updated_at = datetime('now') WHERE id = ?`).bind(entityId),
    ]);
    mutated += 1;
  }
  return c.json({ ok: true, operation_id: opId, affected: mutated, dropped }, 200);
});

// --------------------------- export (streaming CSV) ---------------------------

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

bulk.post("/export", async (c) => {
  const body = await c.req.json<BulkBody>().catch(() => ({} as BulkBody));
  const ids = asStringArray(body.entity_ids);
  if (!ids.length) return c.json({ error: "bad_request", message: "entity_ids required" }, 400);
  const conf = checkConfirmation("export", ids, body);
  if (!conf.ok) return c.json(conf.body!, conf.status!);

  const email = c.var.email;
  const key = c.req.header("Idempotency-Key") || null;
  const opId = ulid();
  const claim = await claimIdempotency(c.env, email, key, opId, "export");
  if (claim && claim.reused) {
    if (claim.action_mismatch) return c.json({ error: "idempotency_action_mismatch", message: `key already used for action: ${claim.action_mismatch}` }, 409);
    return c.json({ ok: true, operation_id: claim.operation_id, reused: true, note: "export already generated for this key; re-download via the original response" }, 200);
  }
  const { visible } = await resolveScoped(c.env, email, ids);

  const env = c.env;
  const headers = ["id", "kind", "display_name", "primary_domain", "primary_email_key", "primary_linkedin_key", "status", "quality_score", "updated_at"];

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(headers.join(",") + "\n"));
      const CHUNK = 200;
      try {
        for (let i = 0; i < visible.length; i += CHUNK) {
          const slice = visible.slice(i, i + CHUNK);
          const placeholders = slice.map(() => "?").join(",");
          const r = await env.DB.prepare(
            `SELECT id, kind, display_name, primary_domain, primary_email_key, primary_linkedin_key, status, quality_score, updated_at
               FROM u_entities WHERE id IN (${placeholders}) ORDER BY id`,
          ).bind(...slice).all<Record<string, unknown>>();
          for (const row of (r.results ?? [])) {
            const line = headers.map((h) => csvCell(row[h])).join(",") + "\n";
            controller.enqueue(enc.encode(line));
          }
        }
        // Per-entity audit row (export is read-only but we still record
        // one row per entity so the audit table is uniform across all
        // bulk actions and undo/operation queries are consistent).
        // Batched 100 at a time to keep D1 happy.
        const SUM_CHUNK = 100;
        for (let i = 0; i < visible.length; i += SUM_CHUNK) {
          const slice = visible.slice(i, i + SUM_CHUNK);
          await env.DB.batch(slice.map((eid) =>
            auditStmt(env, opId, "export", eid,
              { exported: false }, { exported: true, headers }, email),
          ));
        }
      } catch (e) {
        controller.enqueue(enc.encode(`# export_error: ${(e as Error).message}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bulk-export-${opId.slice(0, 12)}.csv"`,
      "X-Operation-Id": opId,
      "Cache-Control": "no-store",
    },
  });
});

// --------------------------- undo ---------------------------

interface AuditRow {
  id: number;
  action: BulkAction;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  undone_at: string | null;
  undo_conflict: number;
}

bulk.post("/undo/:opId", async (c) => {
  const opId = c.req.param("opId");
  const email = c.var.email;
  const within = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM bulk_operation_audit
      WHERE operation_id = ? AND performed_by_email = ?
        AND performed_at > datetime('now','-24 hours') LIMIT 1`,
  ).bind(opId, email).first<{ ok: number }>();
  if (!within) return c.json({ error: "not_found_or_expired", message: "operation_id not found or older than 24h" }, 404);

  const rowsRes = await c.env.DB.prepare(
    `SELECT id, action, entity_id, before_json, after_json, undone_at, undo_conflict
       FROM bulk_operation_audit
      WHERE operation_id = ? AND performed_by_email = ?`,
  ).bind(opId, email).all<AuditRow>();
  const rows: AuditRow[] = rowsRes.results ?? [];

  let reverted = 0; let conflicts = 0; let skipped = 0;
  for (const row of rows) {
    if (row.undone_at) { skipped += 1; continue; }
    if (row.entity_id === "_summary") { skipped += 1; continue; } // export rows aren't replayable
    let before: Record<string, unknown> = {};
    let after: Record<string, unknown> = {};
    try { before = row.before_json ? JSON.parse(row.before_json) : {}; } catch { /* ignore */ }
    try { after = row.after_json ? JSON.parse(row.after_json) : {}; } catch { /* ignore */ }
    try {
      const conflict = await undoOne(c.env, row.action, row.entity_id, before, after);
      if (conflict) {
        conflicts += 1;
        await c.env.DB.prepare(`UPDATE bulk_operation_audit SET undo_conflict = 1 WHERE id = ?`).bind(row.id).run();
      } else {
        reverted += 1;
        await c.env.DB.prepare(`UPDATE bulk_operation_audit SET undone_at = datetime('now') WHERE id = ?`).bind(row.id).run();
      }
    } catch (e) {
      conflicts += 1;
      console.warn("undo failed", opId, row.entity_id, (e as Error).message);
      await c.env.DB.prepare(`UPDATE bulk_operation_audit SET undo_conflict = 1 WHERE id = ?`).bind(row.id).run();
    }
  }
  return c.json({ ok: true, operation_id: opId, reverted, conflicts, skipped }, 200);
});

async function undoOne(
  env: Env, action: BulkAction, entityId: string,
  before: Record<string, unknown>, after: Record<string, unknown>,
): Promise<boolean> {
  // Returns true if the row was further mutated since the audit (undo conflict)
  // and the inverse was therefore not applied.
  if (action === "assign_role") {
    const role = String(after.role ?? before.role ?? "");
    if (!role) return false;
    const wasPresent = before.exists === true;
    const isNowPresent = after.exists === true;
    const currentRow = await env.DB.prepare(
      `SELECT id FROM entity_roles WHERE entity_id = ? AND role = ?`,
    ).bind(entityId, role).first<{ id: number }>();
    const currentlyPresent = !!currentRow;
    if (currentlyPresent !== isNowPresent) return true; // mutated since audit
    if (wasPresent && !isNowPresent) {
      // Was removed → re-add
      await env.DB.prepare(
        `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence) VALUES (?, ?, 0, 'bulk-undo', 1.0)`,
      ).bind(entityId, role).run();
    } else if (!wasPresent && isNowPresent) {
      await env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ? AND role = ?`).bind(entityId, role).run();
    }
    return false;
  }
  if (action === "add_tag") {
    const taxonomy = String(after.taxonomy ?? before.taxonomy ?? "tag");
    const slug = String(after.slug ?? before.slug ?? "");
    if (!slug) return false;
    const currentRow = await env.DB.prepare(
      `SELECT id FROM entity_tags WHERE entity_id = ? AND taxonomy = ? AND slug = ?`,
    ).bind(entityId, taxonomy, slug).first<{ id: number }>();
    const currentlyPresent = !!currentRow;
    if (!currentlyPresent) return true; // already removed by something else
    await env.DB.prepare(`DELETE FROM entity_tags WHERE entity_id = ? AND taxonomy = ? AND slug = ?`)
      .bind(entityId, taxonomy, slug).run();
    return false;
  }
  if (action === "delete") {
    const beforeStatus = String(before.status ?? "active");
    const current = await env.DB.prepare(`SELECT status FROM u_entities WHERE id = ?`).bind(entityId).first<{ status: string }>();
    if (!current) return true;
    if (current.status !== "soft_deleted") return true; // someone reactivated already
    await env.DB.prepare(`UPDATE u_entities SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(beforeStatus, entityId).run();
    return false;
  }
  if (action === "merge") {
    // Merge is intentionally not auto-reversible; flag as conflict so
    // the operator unmerges manually with the existing /entities/:id/unmerge.
    return true;
  }
  if (action === "enrich" || action === "export") {
    // No inverse — these are non-destructive side-effects.
    return false;
  }
  return false;
}
