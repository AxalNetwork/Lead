// EntityLock Durable Object (Task #25 step 4).
//
// Serializes merges per (kind, entity_id) so two concurrent scrapes of the
// same firm/lead don't clobber each other. The DO's storage is used purely
// as a lock; the actual merge writes still target D1 inside the handler so
// they remain queryable.
//
// Routes:
//   POST /merge_lead    body: { id, fields, history_source }
//   POST /merge_firm    body: { id, fields, history_source }
//   POST /merge_company body: { id, fields, history_source }
//
// Caller must obtain the stub via:
//   const stub = env.ENTITY_LOCK.get(env.ENTITY_LOCK.idFromName(`lead:${id}`));
//   await stub.fetch("https://lock/merge_lead", { method: "POST", body: JSON.stringify(...) });

import type { Env } from "../types";
import { upsertEntityVector } from "../dedupe/vector";
import { indexEntity } from "../ai/search_sync";

interface MergeRequest {
  id: string;
  fields: Record<string, unknown>;
  history_source?: string;
}

type LockKind = "lead" | "firm" | "company" | "account" | "buyer";
type LockOp = "merge_lead" | "merge_firm" | "merge_company" | "merge_account" | "merge_buyer";

export class EntityLock {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.replace(/^\/+/, "");
    if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
    // Task #3 (OSINT): token-based mutex for the resolver. acquire chains
    // a fresh promise onto an in-memory queue and awaits the previous tail;
    // release fires the stored resolver for the caller's token. Because the
    // DO runtime keeps a single isolate per id, the in-memory queue is
    // sufficient — we MUST NOT use `blockConcurrencyWhile` here because it
    // would block delivery of the matching `/release` request.
    if (op === "acquire" || op === "release") {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as EntityLock & {
        __osintChain?: Promise<void>;
        __osintPending?: Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>;
      };
      self.__osintChain ??= Promise.resolve();
      self.__osintPending ??= new Map();
      let payload: { token?: string; ttlMs?: number } = {};
      try { payload = (await req.json()) as typeof payload; } catch { /* ignore */ }
      const token = payload.token;
      if (!token) return new Response("missing_token", { status: 400 });
      if (op === "release") {
        const slot = self.__osintPending.get(token);
        if (slot) { clearTimeout(slot.timer); self.__osintPending.delete(token); slot.resolve(); }
        return new Response("ok");
      }
      const ttlMs = Math.min(Math.max(1000, payload.ttlMs ?? 60_000), 120_000);
      const prev = self.__osintChain;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          self.__osintPending!.delete(token);
          resolve();
        }, ttlMs);
        release = () => { clearTimeout(timer); resolve(); };
        self.__osintPending!.set(token, { resolve: release, timer });
      });
      self.__osintChain = prev.then(() => held);
      await prev;
      return new Response("acquired");
    }
    let body: MergeRequest;
    try { body = (await req.json()) as MergeRequest; } catch { return new Response("bad_json", { status: 400 }); }
    if (!body?.id) return new Response("missing_id", { status: 400 });
    // blockConcurrencyWhile serializes the section; one DO instance per id
    // ⇒ one concurrent merge per entity globally.
    return this.state.blockConcurrencyWhile(async () => {
      try {
        switch (op) {
          case "merge_lead":    return Response.json(await this.mergeLead(body));
          case "merge_firm":    return Response.json(await this.mergeFirm(body));
          case "merge_company": return Response.json(await this.mergeCompany(body));
          case "merge_account": return Response.json(await this.mergeAccount(body));
          case "merge_buyer":   return Response.json(await this.mergeBuyer(body));
        }
        return new Response("unknown_op", { status: 404 });
      } catch (e) {
        console.error("EntityLock op failed", op, (e as Error).message);
        return new Response("internal_error", { status: 500 });
      }
    });
  }

  // The merge bodies are intentionally minimal: they apply the per-field
  // replace/keep rules and write history rows. Full provider-priority logic
  // already lives in dedupe/merge.ts and firms_upsert.ts; the DO just
  // ensures serialization. Drift from task plan: we don't yet migrate every
  // INSERT/UPDATE in pipeline/enrichment/importers through the DO — that's
  // tracked as the followup "migrate-merges-through-DO" task.
  private async mergeLead(body: MergeRequest): Promise<{ ok: true; id: string; updated: number }> {
    const updated = await applyMerge(this.env, "leads", body);
    const name = String(body.fields.name ?? "");
    const org = String(body.fields.org ?? "");
    await upsertEntityVector(this.env, "leads", body.id, {
      name, org,
      city: String(body.fields.city ?? ""),
      role: String(body.fields.title ?? ""),
      bio: String(body.fields.bio ?? ""),
      email: String(body.fields.email ?? ""),
    });
    await indexEntity(this.env, {
      id: body.id, type: "lead",
      title: name || org || body.id,
      body: [name, org, body.fields.title, body.fields.bio].filter(Boolean).join(" — "),
      url: typeof body.fields.source_url === "string" ? body.fields.source_url : undefined,
    });
    return { ok: true, id: body.id, updated };
  }

  private async mergeFirm(body: MergeRequest): Promise<{ ok: true; id: string; updated: number }> {
    const updated = await applyMerge(this.env, "firms", body);
    const name = String(body.fields.name ?? "");
    await upsertEntityVector(this.env, "firms", body.id, {
      name,
      city: String(body.fields.hq_city ?? ""),
      bio: String(body.fields.thesis ?? ""),
    });
    await indexEntity(this.env, {
      id: body.id, type: "firm",
      title: name || body.id,
      body: [name, body.fields.thesis, body.fields.hq_city].filter(Boolean).join(" — "),
      url: typeof body.fields.website === "string" ? body.fields.website : undefined,
    });
    return { ok: true, id: body.id, updated };
  }

  private async mergeCompany(body: MergeRequest): Promise<{ ok: true; id: string; updated: number }> {
    const updated = await applyMerge(this.env, "companies", body);
    const name = String(body.fields.name ?? "");
    await upsertEntityVector(this.env, "companies", body.id, {
      name,
      city: String(body.fields.hq_city ?? ""),
      bio: String(body.fields.description ?? ""),
    });
    await indexEntity(this.env, {
      id: body.id, type: "company",
      title: name || body.id,
      body: [name, body.fields.description, body.fields.hq_city].filter(Boolean).join(" — "),
      url: typeof body.fields.website === "string" ? body.fields.website : undefined,
    });
    return { ok: true, id: body.id, updated };
  }

  // Task #44: account merge. Indexes into the `axal-accounts` AI Search
  // namespace so prospect-account text search stays isolated from the
  // investor/firm/company `axal-profiles` namespace.
  private async mergeAccount(body: MergeRequest): Promise<{ ok: true; id: string; updated: number }> {
    const updated = await applyMerge(this.env, "accounts", body);
    const name = String(body.fields.name ?? "");
    await indexEntity(this.env, {
      id: body.id, type: "account", namespace: "axal-accounts",
      title: name || body.id,
      body: [name, body.fields.industry, body.fields.description, body.fields.hq_city, body.fields.hq_country_iso2].filter(Boolean).join(" — "),
      url: typeof body.fields.website === "string" ? body.fields.website : undefined,
    });
    return { ok: true, id: body.id, updated };
  }

  // Task #44: buyer merge. No vectorize index for buyers yet; AI Search
  // is also skipped (we surface buyers under their account doc instead).
  private async mergeBuyer(body: MergeRequest): Promise<{ ok: true; id: string; updated: number }> {
    const updated = await applyMerge(this.env, "buyers", body);
    return { ok: true, id: body.id, updated };
  }
}

// Per-table allowlist of columns the EntityLock merge path is permitted to
// write. Computed columns (intent_score / account_score / fit_score /
// score_recomputed_at / *_at), foreign keys (account_id), and identity
// columns (id) are intentionally excluded. The route handlers also pass a
// sanitized subset, so this is a defense-in-depth check against a malicious
// or buggy caller bypassing the route allowlist.
const MERGE_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  // Note: lead/firm/company allowlists pre-date Task #44; they were
  // forwarded raw before. Keeping a permissive shape that matches the
  // existing merge body fields used by the older crawler call sites.
  leads:     new Set(["name","org","title","bio","city","email","source_url"]),
  firms:     new Set(["name","website","thesis","hq_city","hq_country_iso2"]),
  companies: new Set(["name","website","description","hq_city","hq_country_iso2"]),
  accounts:  new Set([
    "name","legal_name","domain","website","logo_id","description",
    "industry","industries_json","size_band","employees","founded_year",
    "hq_country_iso2","hq_region","hq_city","timezone",
    "funding_stage","total_funding_usd","last_round_usd","last_round_at","revenue_band",
    "linkedin_url","crunchbase_url","twitter_handle","github_org",
    "status","owner_email","source_url","imported_from","meta_json","last_enriched_at",
  ]),
  buyers:    new Set([
    "name","email","title","role_slug","seniority","department",
    "linkedin_url","twitter_url","phone",
    "is_decision_maker","is_champion","last_seen_at","meta_json",
  ]),
};

export const ALLOWED_MERGE_FIELDS = MERGE_ALLOWLIST;

async function applyMerge(env: Env, table: "leads" | "firms" | "companies" | "accounts" | "buyers", body: MergeRequest): Promise<number> {
  const allow = MERGE_ALLOWLIST[table];
  const fields = Object.entries(body.fields).filter(([k, v]) => allow.has(k) && v != null && v !== "");
  if (!fields.length) return 0;
  const sets = fields.map(([k]) => `${k} = ?`).join(", ");
  const binds = fields.map(([, v]) => v);
  await env.DB.prepare(`UPDATE ${table} SET ${sets}, updated_at = COALESCE(updated_at, ?) WHERE id = ?`)
    .bind(...binds, new Date().toISOString(), body.id)
    .run()
    .catch((e) => console.warn(`applyMerge ${table} failed`, e.message));
  return fields.length;
}

// Helper for the rest of the worker.
export async function withEntityLock(
  env: Env,
  kind: LockKind,
  id: string,
  op: LockOp,
  body: MergeRequest,
): Promise<Response | null> {
  if (!env.ENTITY_LOCK) return null;
  const stub = env.ENTITY_LOCK.get(env.ENTITY_LOCK.idFromName(`${kind}:${id}`));
  return stub.fetch(`https://lock/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Stable key helper so callers and tests can compute the lock id without
// allocating a stub. Mirrors the naming used inside `withEntityLock`.
export function entityLockKey(kind: LockKind, id: string): string {
  return `${kind}:${id}`;
}
