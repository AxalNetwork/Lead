import type { Env } from "../types";
import type { EntityKind, EntityRole, EntityRow } from "./model";

export async function createEntity(
  env: Env,
  init: {
    kind: EntityKind;
    display_name?: string | null;
    primary_url?: string | null;
    primary_domain?: string | null;
    primary_email_key?: string | null;
    primary_linkedin_key?: string | null;
    primary_twitter_handle?: string | null;
    primary_github_handle?: string | null;
  },
): Promise<EntityRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO u_entities (
       id, kind, display_name, primary_url, primary_domain,
       primary_email_key, primary_linkedin_key, primary_twitter_handle, primary_github_handle,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(
    id, init.kind,
    init.display_name ?? null,
    init.primary_url ?? null,
    init.primary_domain ?? null,
    init.primary_email_key ?? null,
    init.primary_linkedin_key ?? null,
    init.primary_twitter_handle ?? null,
    init.primary_github_handle ?? null,
    now, now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO entity_history (id, entity_id, action, source, changed_at) VALUES (?, ?, 'create', 'system', ?)`,
  ).bind(crypto.randomUUID(), id, now).run();
  return (await env.DB.prepare(`SELECT * FROM u_entities WHERE id = ?`).bind(id).first<EntityRow>())!;
}

export async function addRole(
  env: Env,
  entityId: string,
  role: EntityRole,
  opts?: { is_primary?: boolean; source?: string; confidence?: number },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO entity_roles (entity_id, role, is_primary, source, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, role) DO UPDATE SET
         is_primary = MAX(is_primary, excluded.is_primary),
         confidence = MAX(confidence, excluded.confidence)`,
    ).bind(entityId, role, opts?.is_primary ? 1 : 0, opts?.source ?? null, opts?.confidence ?? 1).run();
  } catch (e) {
    console.warn("addRole failed", role, (e as Error).message);
  }
}

export async function getLegacyEntityId(
  env: Env,
  table: "firms" | "leads" | "companies" | "accounts" | "buyers",
  legacyId: string | number,
): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM entity_legacy_map WHERE legacy_table = ? AND legacy_id = ?`,
  ).bind(table, String(legacyId)).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

export async function setLegacyEntityId(
  env: Env,
  table: "firms" | "leads" | "companies" | "accounts" | "buyers",
  legacyId: string | number,
  entityId: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(table, String(legacyId), entityId).run();
  } catch (e) {
    console.warn("setLegacyEntityId failed", table, legacyId, (e as Error).message);
  }
}
