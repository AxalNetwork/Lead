import type { Env } from "../types";
import type { EntityKind, EntityRole, EntityRow } from "./model";
import { isGarbage, logDataQuality, classifyPersonName } from "./garbage";

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
    /**
     * Internal-only knob: when true, skip the auto-dispatch of
     * WF_PROFILE_FILLER below. Callers that create org entities as a
     * side effect of an already-running profile fill (e.g. portfolio
     * companies discovered by the filler) MUST set this — otherwise a
     * single investor fill cascades into one fill per portfolio
     * company, blowing the daily neuron cap.
     */
    suppressAutoProfileFill?: boolean;
  },
): Promise<EntityRow | null> {
  // Task #9: pre-insert garbage guard. The pure heuristic detector
  // (no AI call here — keep createEntity synchronous and cheap on the
  // hot write path) rejects HTML page titles / nav strings / UI
  // labels that the crawler may have mistaken for entity names.
  // Returns null + audit row instead of throwing so callers can
  // skip without crashing the broader import. The AI second opinion
  // runs only in the cron sweep, NOT inline on every write.
  const verdict = isGarbage({
    kind: init.kind,
    display_name: init.display_name ?? null,
    primary_url: init.primary_url ?? null,
    primary_domain: init.primary_domain ?? null,
    primary_email_key: init.primary_email_key ?? null,
    primary_linkedin_key: init.primary_linkedin_key ?? null,
  });
  if (verdict.is_garbage) {
    console.log("garbage.pre_insert_rejected", JSON.stringify({
      kind: init.kind, display_name: init.display_name, reasons: verdict.reasons,
    }));
    // Log to data_quality_log with a synthetic entity_id so operators
    // can audit rejected writes too. We use a `rejected:` prefix to
    // distinguish from soft-deleted entities (which carry real ids).
    void logDataQuality(
      env, "rejected:" + (init.display_name ?? "<empty>").slice(0, 100),
      "pre_insert_rejected", verdict.reasons, "pre_insert_guard", null,
    ).catch(() => undefined);
    return null;
  }
  // Task #6: reclassify-on-write. A `person` whose display name is clearly
  // an organization ("Intel Capital", "Mendoza Ventures") is written as an
  // `org` so it never lands in the People list in the first place. A strong
  // personal identifier (personal LinkedIn /in/ or email) contradicting the
  // org-suffix name suppresses the flip — never mislabel a likely real
  // person. Junk names were already rejected by the isGarbage guard above.
  let effectiveKind: EntityKind = init.kind;
  let reclassifiedOrgRole: EntityRole | null = null;
  if (init.kind === "person") {
    const cls = classifyPersonName(init.display_name ?? null);
    if (cls.verdict === "organization" && cls.orgRole) {
      const personalLinkedin = !!init.primary_linkedin_key && /(^|\/)in\//i.test(init.primary_linkedin_key);
      const hasEmail = !!init.primary_email_key;
      if (!personalLinkedin && !hasEmail) {
        effectiveKind = "org";
        reclassifiedOrgRole = cls.orgRole;
      }
    }
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO u_entities (
       id, kind, display_name, primary_url, primary_domain,
       primary_email_key, primary_linkedin_key, primary_twitter_handle, primary_github_handle,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(
    id, effectiveKind,
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
  // Task #8: enqueue persona ↔ entity matching for newly-created
  // person entities so a freshly-created founder/operator appears in
  // matching personas' candidate lists within minutes — even before
  // any career/title facts are written. KV-debounced inside trigger.
  if (effectiveKind === "person") {
    try {
      const { triggerEntityMatchRefresh } = await import("../services/personaMatchTrigger.js");
      void triggerEntityMatchRefresh(env, id).catch(() => undefined);
    } catch { /* best-effort */ }
  }
  // Task #6: stamp the inferred org role + an audit row when a person was
  // reclassified to an org on write, so the operator console can trace it.
  if (reclassifiedOrgRole) {
    await addRole(env, id, reclassifiedOrgRole, { is_primary: true, source: "garbage_reclassify_on_write" });
    void logDataQuality(
      env, id, "reclassified",
      [`org_role:${reclassifiedOrgRole}`, "reclassified_on_write"],
      "pre_insert_guard", null,
    ).catch(() => undefined);
  }
  // Task #3 (AI Profile Filler): auto-trigger a profile fill for newly
  // created org entities that have a website but no facts yet (the
  // signal-poor "low confidence" case the spec calls out). Dispatched
  // via WF binding when available so the cost is async and respects
  // the daily neuron cap. No-op when the binding isn't configured.
  if (effectiveKind === "org" && (init.primary_url || init.primary_domain) && !init.suppressAutoProfileFill) {
    const wf = (env as Env & { WF_PROFILE_FILLER?: { create: (o: { params: Record<string, unknown> }) => Promise<{ id: string }> } }).WF_PROFILE_FILLER;
    if (wf) {
      try {
        void wf.create({ params: { entityId: id, force: false, triggeredBy: "auto:entity_created" } }).catch(() => undefined);
      } catch { /* best-effort */ }
    }
  }
  // Task #4 (Relationship Inference Worker): debounced enqueue into
  // relationship_infer_queue (migration 377). The consolidated nightly
  // slot drains the queue with the per-entity orchestrator pass.
  try {
    const { enqueueRelInfer } = await import("../services/relationships/orchestrator.js");
    void enqueueRelInfer(env, id, `created:${effectiveKind}`).catch(() => undefined);
  } catch { /* best-effort */ }
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
