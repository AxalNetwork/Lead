// Task #3: Profile classifier — DB repo helpers.
//
// All writes are upserts keyed on entity_id so re-running the classifier
// for the same entity overwrites cleanly. Manual overrides are preserved
// (see applyManualOverrides() in classifier.ts).

import type { Env } from "../types";

export interface ProfileAxesRow {
  entity_id: string;
  type_weights_json: string | null;
  primary_type: string | null;
  primary_type_conf: number | null;
  left_right: number | null;
  lib_auth: number | null;
  prog_cons: number | null;
  glob_nat: number | null;
  sec_rel: number | null;
  ideology_conf: number | null;
  network_centrality: number | null;
  media_influence: number | null;
  capital_influence: number | null;
  political_influence: number | null;
  interests_json: string | null;
  hobbies_json: string | null;
  causes_json: string | null;
  summary_text: string | null;
  summary_evidence_hash: string | null;
  is_pep: number;
  is_government_official: number;
  is_lobbyist: number;
  evidence_count: number;
  manual_override_json: string | null;
  classifier_version: string | null;
  classified_at: string | null;
  refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileAxesPatch {
  type_weights?: Record<string, number> | null;
  primary_type?: string | null;
  primary_type_conf?: number | null;
  left_right?: number | null;
  lib_auth?: number | null;
  prog_cons?: number | null;
  glob_nat?: number | null;
  sec_rel?: number | null;
  ideology_conf?: number | null;
  network_centrality?: number | null;
  media_influence?: number | null;
  capital_influence?: number | null;
  political_influence?: number | null;
  interests?: unknown[] | null;
  hobbies?: unknown[] | null;
  causes?: unknown[] | null;
  summary_text?: string | null;
  summary_evidence_hash?: string | null;
  is_pep?: 0 | 1;
  is_government_official?: 0 | 1;
  is_lobbyist?: 0 | 1;
  evidence_count?: number;
  classifier_version?: string | null;
  classified_at?: string | null;
  refreshed_at?: string | null;
}

export async function getProfileAxes(env: Env, entityId: string): Promise<ProfileAxesRow | null> {
  return await env.DB.prepare(`SELECT * FROM entity_profile_axes WHERE entity_id = ?`)
    .bind(entityId)
    .first<ProfileAxesRow>();
}

export async function upsertProfileAxes(env: Env, entityId: string, patch: ProfileAxesPatch): Promise<void> {
  // Pull manual overrides + existing values so we never overwrite operator-set fields.
  const existing = await getProfileAxes(env, entityId);
  const manual = existing?.manual_override_json ? safeJson<Record<string, unknown>>(existing.manual_override_json) ?? {} : {};

  const overrideField = <T>(field: string, candidate: T | undefined, current: T | null | undefined): T | null => {
    if (Object.prototype.hasOwnProperty.call(manual, field)) {
      const m = manual[field] as { value?: T } | undefined;
      return (m?.value ?? null) as T | null;
    }
    if (candidate !== undefined) return candidate;
    return (current ?? null) as T | null;
  };

  const typeWeightsJson = patch.type_weights !== undefined
    ? (patch.type_weights ? JSON.stringify(patch.type_weights) : null)
    : (existing?.type_weights_json ?? null);

  const interestsJson = patch.interests !== undefined ? (patch.interests ? JSON.stringify(patch.interests) : null) : (existing?.interests_json ?? null);
  const hobbiesJson   = patch.hobbies   !== undefined ? (patch.hobbies   ? JSON.stringify(patch.hobbies)   : null) : (existing?.hobbies_json   ?? null);
  const causesJson    = patch.causes    !== undefined ? (patch.causes    ? JSON.stringify(patch.causes)    : null) : (existing?.causes_json    ?? null);

  const now = new Date().toISOString();
  const row = {
    entity_id: entityId,
    type_weights_json: typeWeightsJson,
    primary_type: overrideField("primary_type", patch.primary_type, existing?.primary_type),
    primary_type_conf: overrideField("primary_type_conf", patch.primary_type_conf, existing?.primary_type_conf),
    left_right: overrideField("left_right", patch.left_right, existing?.left_right),
    lib_auth: overrideField("lib_auth", patch.lib_auth, existing?.lib_auth),
    prog_cons: overrideField("prog_cons", patch.prog_cons, existing?.prog_cons),
    glob_nat: overrideField("glob_nat", patch.glob_nat, existing?.glob_nat),
    sec_rel: overrideField("sec_rel", patch.sec_rel, existing?.sec_rel),
    ideology_conf: patch.ideology_conf ?? existing?.ideology_conf ?? null,
    network_centrality: patch.network_centrality ?? existing?.network_centrality ?? null,
    media_influence: patch.media_influence ?? existing?.media_influence ?? null,
    capital_influence: patch.capital_influence ?? existing?.capital_influence ?? null,
    political_influence: patch.political_influence ?? existing?.political_influence ?? null,
    interests_json: interestsJson,
    hobbies_json: hobbiesJson,
    causes_json: causesJson,
    summary_text: patch.summary_text ?? existing?.summary_text ?? null,
    summary_evidence_hash: patch.summary_evidence_hash ?? existing?.summary_evidence_hash ?? null,
    is_pep: (patch.is_pep ?? existing?.is_pep ?? 0) as number,
    is_government_official: (patch.is_government_official ?? existing?.is_government_official ?? 0) as number,
    is_lobbyist: (patch.is_lobbyist ?? existing?.is_lobbyist ?? 0) as number,
    evidence_count: patch.evidence_count ?? existing?.evidence_count ?? 0,
    classifier_version: patch.classifier_version ?? existing?.classifier_version ?? null,
    classified_at: patch.classified_at ?? existing?.classified_at ?? null,
    refreshed_at: patch.refreshed_at ?? now,
  };

  await env.DB.prepare(
    `INSERT INTO entity_profile_axes
       (entity_id, type_weights_json, primary_type, primary_type_conf,
        left_right, lib_auth, prog_cons, glob_nat, sec_rel, ideology_conf,
        network_centrality, media_influence, capital_influence, political_influence,
        interests_json, hobbies_json, causes_json,
        summary_text, summary_evidence_hash,
        is_pep, is_government_official, is_lobbyist,
        evidence_count, classifier_version, classified_at, refreshed_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       type_weights_json=excluded.type_weights_json,
       primary_type=excluded.primary_type,
       primary_type_conf=excluded.primary_type_conf,
       left_right=excluded.left_right,
       lib_auth=excluded.lib_auth,
       prog_cons=excluded.prog_cons,
       glob_nat=excluded.glob_nat,
       sec_rel=excluded.sec_rel,
       ideology_conf=excluded.ideology_conf,
       network_centrality=excluded.network_centrality,
       media_influence=excluded.media_influence,
       capital_influence=excluded.capital_influence,
       political_influence=excluded.political_influence,
       interests_json=excluded.interests_json,
       hobbies_json=excluded.hobbies_json,
       causes_json=excluded.causes_json,
       summary_text=excluded.summary_text,
       summary_evidence_hash=excluded.summary_evidence_hash,
       is_pep=excluded.is_pep,
       is_government_official=excluded.is_government_official,
       is_lobbyist=excluded.is_lobbyist,
       evidence_count=excluded.evidence_count,
       classifier_version=excluded.classifier_version,
       classified_at=excluded.classified_at,
       refreshed_at=excluded.refreshed_at,
       updated_at=?`,
  ).bind(
    row.entity_id, row.type_weights_json, row.primary_type, row.primary_type_conf,
    row.left_right, row.lib_auth, row.prog_cons, row.glob_nat, row.sec_rel, row.ideology_conf,
    row.network_centrality, row.media_influence, row.capital_influence, row.political_influence,
    row.interests_json, row.hobbies_json, row.causes_json,
    row.summary_text, row.summary_evidence_hash,
    row.is_pep, row.is_government_official, row.is_lobbyist,
    row.evidence_count, row.classifier_version, row.classified_at, row.refreshed_at,
    now, now, now,
  ).run();
}

export async function setManualOverride(env: Env, entityId: string, field: string, value: unknown, by: string, note?: string): Promise<void> {
  const cur = await getProfileAxes(env, entityId);
  const manual = (cur?.manual_override_json ? safeJson<Record<string, unknown>>(cur.manual_override_json) : null) ?? {};
  if (value === null || value === undefined) {
    delete manual[field];
  } else {
    manual[field] = { value, by, note: note ?? null, at: new Date().toISOString() };
  }
  const json = Object.keys(manual).length ? JSON.stringify(manual) : null;
  if (!cur) {
    await env.DB.prepare(
      `INSERT INTO entity_profile_axes (entity_id, manual_override_json, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(entityId, json).run();
  } else {
    await env.DB.prepare(
      `UPDATE entity_profile_axes SET manual_override_json = ?, updated_at = CURRENT_TIMESTAMP WHERE entity_id = ?`,
    ).bind(json, entityId).run();
  }
}

export async function insertEvidence(env: Env, rows: Array<{
  entity_id: string;
  axis: string;
  score?: number | null;
  quote: string;
  source_kind: string;
  source_url?: string | null;
  news_item_id?: string | null;
  observed_at?: string | null;
}>): Promise<void> {
  if (!rows.length) return;
  const stmts = rows.slice(0, 200).map((r) =>
    env.DB.prepare(
      `INSERT INTO entity_evidence_quotes (id, entity_id, axis, score, quote, source_kind, source_url, news_item_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      r.entity_id,
      r.axis,
      r.score ?? null,
      String(r.quote ?? "").slice(0, 600),
      r.source_kind,
      r.source_url ?? null,
      r.news_item_id ?? null,
      r.observed_at ?? null,
    ),
  );
  await env.DB.batch(stmts);
}

export async function getEvidence(env: Env, entityId: string, axis?: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  const sql = axis
    ? `SELECT * FROM entity_evidence_quotes WHERE entity_id = ? AND axis = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM entity_evidence_quotes WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`;
  const bind = axis ? [entityId, axis, limit] : [entityId, limit];
  const r = await env.DB.prepare(sql).bind(...bind).all();
  return (r.results ?? []) as Array<Record<string, unknown>>;
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
