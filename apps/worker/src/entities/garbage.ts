// Task #9: Garbage Entity Detector & Cleanup.
//
// Pure detector (`isGarbage`) flags HTML page titles / nav fragments /
// UI strings polluting `u_entities`. Used by:
//   * The pre-insert guard in `createEntity` (rejects before write).
//   * The cron sweep (`runCleanupSweep`) that soft-deletes recently-
//     created garbage and, on `mode='all'`, performs the one-off pass.
//   * The /ops/garbage-review/ console (admin restore / purge).
//
// HONEST DEGRADATION (Task #14 pattern): the optional Workers AI second
// opinion (`aiSecondOpinion`) returns `uncertain` when the `env.AI`
// binding is absent, on any HTTP/network error, or when the JSON
// response is malformed. `evaluateEntity` then DOES NOT flag the
// entity — never silently garbage.

import type { Env } from "../types";
import type { EntityKind } from "./model";

export interface GarbageInput {
  kind: EntityKind | string;
  display_name?: string | null;
  primary_url?: string | null;
  primary_domain?: string | null;
  primary_email_key?: string | null;
  primary_linkedin_key?: string | null;
}

export interface GarbageVerdict {
  is_garbage: boolean;
  reasons: string[];
}

const NAME_MAX_LEN = 80;

// Curated UI / nav strings observed in production on the Investors page.
// Lowercased for comparison.
const KNOWN_UI_STRINGS = new Set([
  "contact us", "contact", "search icon", "search", "home", "about",
  "about us", "menu", "login", "log in", "sign in", "sign up",
  "sign-up", "register", "our team", "team", "limited partners",
  "portfolio", "our portfolio", "careers", "jobs", "privacy",
  "privacy policy", "terms", "terms of service", "cookies",
  "cookie policy", "blog", "news", "press", "press releases",
  "get in touch", "subscribe", "newsletter", "footer", "header",
  "navigation", "nav", "skip to content", "back to top", "read more",
  "learn more", "view all", "see all", "all rights reserved",
  "follow us", "share", "tweet", "facebook", "twitter", "linkedin",
  "instagram", "youtube", "the team", "our story",
]);

// Heuristic leaders that strongly indicate a press/blog post title
// got captured as an "entity".
const LEADER_RE =
  /^(introducing|announcing|welcome to|how|why|what|when|where|the future of|inside)\s+/i;

// Page-title with `|`-separated domain/brand fragment. Examples:
// "Our Team | Sequoia Capital", "Contact Tenity | Get in Touch",
// "Home | Sequoia Capital".
const PIPE_TITLE_RE = /\s\|\s\S/;

// Pure emoji / icon names (no alphanumerics at all).
const NO_ALNUM_RE = /^[^\p{L}\p{N}]+$/u;

/** Pure detector. NO IO. Safe to call inline on every entity write. */
export function isGarbage(input: GarbageInput): GarbageVerdict {
  const reasons: string[] = [];
  const raw = (input.display_name ?? "").trim();

  // Rule 1: empty or whitespace-only name.
  if (!raw) {
    reasons.push("empty_name");
    return { is_garbage: true, reasons };
  }

  // Rule 2: name longer than 80 chars.
  if (raw.length > NAME_MAX_LEN) reasons.push("name_too_long");

  // Rule 3: pure emoji / icon (no letters or digits).
  if (NO_ALNUM_RE.test(raw)) reasons.push("no_alphanumeric_chars");

  // Rule 4: page-title with `|` brand fragment.
  if (PIPE_TITLE_RE.test(raw)) reasons.push("page_title_pipe_fragment");

  // Rule 5: blog/press leader phrase.
  if (LEADER_RE.test(raw)) reasons.push("press_leader_phrase");

  // Rule 6: known UI / nav string (case-insensitive exact match).
  if (KNOWN_UI_STRINGS.has(raw.toLowerCase())) reasons.push("known_ui_string");

  // Rule 7: person-specific constraints — must contain a space AND
  // must not contain pipe / slash / colon. Real human display names
  // are "First Last", not "Contact | Sequoia" or "team/people:1".
  if (input.kind === "person") {
    if (!/\s/.test(raw)) reasons.push("person_no_space");
    if (/[|/:]/.test(raw)) reasons.push("person_contains_separator");
  }

  return { is_garbage: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Structural rule (requires DB lookups): zero facts AND zero relationships
// AND zero contact channels AND crawler-created >24h ago. Used by the
// cron sweep — NOT by the pre-insert guard (the entity hasn't been
// written yet, so it has no joins).
// ---------------------------------------------------------------------------
export async function isStructurallyOrphan(
  env: Env,
  entityId: string,
  options: { minAgeHours?: number } = {},
): Promise<{ orphan: boolean; reasons: string[] }> {
  const minAge = options.minAgeHours ?? 24;
  const reasons: string[] = [];
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM facts            WHERE entity_id = ?1) AS facts,
         (SELECT COUNT(*) FROM rel_edges        WHERE src_entity_id = ?1 OR dst_entity_id = ?1) AS rels,
         (SELECT COUNT(*) FROM entity_channels  WHERE entity_id = ?1) AS chans,
         (SELECT (julianday('now') - julianday(created_at)) * 24 FROM u_entities WHERE id = ?1) AS age_hours`,
    ).bind(entityId).first<{ facts: number; rels: number; chans: number; age_hours: number | null }>();
    if (!row) return { orphan: false, reasons };
    const ageHours = Number(row.age_hours ?? 0);
    if (Number(row.facts) === 0 && Number(row.rels) === 0 && Number(row.chans) === 0 && ageHours >= minAge) {
      reasons.push("structural_orphan_no_signal");
      return { orphan: true, reasons };
    }
  } catch (e) {
    // Optional source tables (entity_channels) may be missing in test
    // DBs — degrade to "not orphan" rather than throwing. Per the
    // Task #14 honest-degradation pattern.
    console.warn("isStructurallyOrphan probe failed", entityId, (e as Error).message);
  }
  return { orphan: false, reasons };
}

// ---------------------------------------------------------------------------
// Optional AI second opinion for ambiguous mid-length names.
// ---------------------------------------------------------------------------
export interface AiVerdict {
  verdict: "garbage" | "real" | "uncertain";
  confidence: number;
  reason?: string;
}

const AI_PROMPT = `You are a data-quality filter for a CRM. Given a candidate \
entity record, decide whether the display_name is a real person/organization \
name or noise scraped from an HTML page (page titles, nav labels, "Contact Us", \
press headlines like "Introducing X", marketing blurbs, etc.).
Reply ONLY as compact JSON: {"verdict":"garbage|real|uncertain","confidence":0.0-1.0,"reason":"<short>"}.`;

export async function aiSecondOpinion(env: Env, input: GarbageInput): Promise<AiVerdict> {
  if (!env.AI || typeof env.AI.run !== "function") {
    return { verdict: "uncertain", confidence: 0, reason: "ai_binding_missing" };
  }
  const payload = {
    kind: input.kind,
    display_name: input.display_name ?? null,
    primary_url: input.primary_url ?? null,
    primary_domain: input.primary_domain ?? null,
  };
  try {
    const res = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: AI_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      max_tokens: 80,
    })) as { response?: string } | string;
    const text = typeof res === "string" ? res : (res?.response ?? "");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { verdict: "uncertain", confidence: 0, reason: "ai_no_json" };
    const parsed = JSON.parse(match[0]) as Partial<AiVerdict>;
    const verdict = parsed.verdict === "garbage" || parsed.verdict === "real" ? parsed.verdict : "uncertain";
    const conf = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return { verdict, confidence: conf, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
  } catch (e) {
    return { verdict: "uncertain", confidence: 0, reason: "ai_error:" + (e as Error).message };
  }
}

/**
 * Combined verdict: heuristic detector + optional AI second opinion
 * for names 30–60 chars that don't match any heuristic. AI flags only
 * when verdict='garbage' AND confidence > 0.8. When AI is unavailable
 * or returns 'uncertain', the entity is NOT flagged.
 */
export async function evaluateEntity(
  env: Env,
  input: GarbageInput,
  opts: { skipAi?: boolean } = {},
): Promise<GarbageVerdict> {
  const heur = isGarbage(input);
  if (heur.is_garbage) return heur;
  if (opts.skipAi) return heur;
  const name = (input.display_name ?? "").trim();
  if (name.length < 30 || name.length > 60) return heur;
  const ai = await aiSecondOpinion(env, input);
  if (ai.verdict === "garbage" && ai.confidence > 0.8) {
    return { is_garbage: true, reasons: ["ai_second_opinion", `ai_conf:${ai.confidence.toFixed(2)}`] };
  }
  return heur;
}

// ---------------------------------------------------------------------------
// Soft-delete / restore / purge helpers. All write through
// `data_quality_log` so the operator console can audit every transition.
// ---------------------------------------------------------------------------
export async function logDataQuality(
  env: Env,
  entityId: string,
  issue: string,
  reasons: string[],
  source: string,
  actorEmail?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO data_quality_log (entity_id, issue, reasons_json, source, actor_email)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(entityId, issue, JSON.stringify(reasons), source, actorEmail ?? null).run();
  } catch (e) {
    console.warn("data_quality_log insert failed", entityId, (e as Error).message);
  }
}

export async function softDeleteEntity(
  env: Env,
  entityId: string,
  reasons: string[],
  source: string,
  actorEmail?: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE u_entities
        SET status = 'soft_deleted',
            deleted_reason = COALESCE(deleted_reason, ?),
            updated_at = datetime('now')
      WHERE id = ? AND status != 'soft_deleted'`,
  ).bind("garbage_detector_v1:" + reasons.join(","), entityId).run();
  try {
    await env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ?`).bind(entityId).run();
  } catch (e) {
    console.warn("entity_roles delete during soft-delete failed", entityId, (e as Error).message);
  }
  await logDataQuality(env, entityId, "soft_deleted", reasons, source, actorEmail);
}

export async function restoreEntity(env: Env, entityId: string, actorEmail: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE u_entities
        SET status = 'active',
            deleted_reason = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).bind(entityId).run();
  await logDataQuality(env, entityId, "restored", [], "operator", actorEmail);
}

export async function purgeEntity(env: Env, entityId: string, actorEmail: string): Promise<void> {
  // Best-effort cascade across the optional referencing tables; each
  // wrapped in its own try/catch so a missing table doesn't block the
  // primary delete. Per the Task #14 honest-degradation pattern.
  const cascades = [
    `DELETE FROM facts WHERE entity_id = ?`,
    `DELETE FROM rel_edges WHERE src_entity_id = ? OR dst_entity_id = ?`,
    `DELETE FROM entity_channels WHERE entity_id = ?`,
    `DELETE FROM entity_roles WHERE entity_id = ?`,
    `DELETE FROM entity_history WHERE entity_id = ?`,
    `DELETE FROM entity_legacy_map WHERE entity_id = ?`,
  ];
  for (const sql of cascades) {
    try {
      if (sql.includes("OR dst_entity_id")) {
        await env.DB.prepare(sql).bind(entityId, entityId).run();
      } else {
        await env.DB.prepare(sql).bind(entityId).run();
      }
    } catch (e) {
      // table-missing or FK noise — log and continue
      console.warn("purge cascade failed", sql.slice(0, 40), (e as Error).message);
    }
  }
  // Log BEFORE the final delete so the audit trail survives even if
  // the row-delete races a concurrent reader. data_quality_log keeps
  // entity_id as TEXT (no FK), so the row remains queryable.
  await logDataQuality(env, entityId, "purged", [], "operator", actorEmail);
  await env.DB.prepare(`DELETE FROM u_entities WHERE id = ?`).bind(entityId).run();
}

// ---------------------------------------------------------------------------
// Sweep. Two modes:
//   * mode='recent': entities created in the last `lookbackHours` (cron path)
//   * mode='all':    full scan (one-off cleanup; admin-triggered)
// Both bounded at `limit` (default 5000) per the spec.
// ---------------------------------------------------------------------------
export interface SweepResult {
  scanned: number;
  flagged: number;
  soft_deleted: number;
  by_reason: Record<string, number>;
  bounded: boolean;
}

export async function runCleanupSweep(
  env: Env,
  opts: {
    mode?: "recent" | "all";
    lookbackHours?: number;
    limit?: number;
    source?: string;
    actorEmail?: string | null;
    skipAi?: boolean;
  } = {},
): Promise<SweepResult> {
  const mode = opts.mode ?? "recent";
  const lookback = opts.lookbackHours ?? 24;
  const limit = opts.limit ?? 5000;
  const source = opts.source ?? (mode === "all" ? "oneoff_cleanup" : "cron_sweep");

  const where = mode === "all"
    ? `status NOT IN ('soft_deleted','merged')`
    : `status NOT IN ('soft_deleted','merged') AND created_at >= datetime('now', '-${lookback} hours')`;

  const rows = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain, primary_email_key, primary_linkedin_key
       FROM u_entities
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(limit).all<{
    id: string; kind: string; display_name: string | null;
    primary_url: string | null; primary_domain: string | null;
    primary_email_key: string | null; primary_linkedin_key: string | null;
  }>();

  const items = rows.results ?? [];
  const byReason: Record<string, number> = {};
  let flagged = 0;
  let softDeleted = 0;

  for (const r of items) {
    const heur = isGarbage({
      kind: r.kind, display_name: r.display_name,
      primary_url: r.primary_url, primary_domain: r.primary_domain,
      primary_email_key: r.primary_email_key, primary_linkedin_key: r.primary_linkedin_key,
    });
    let reasons = heur.reasons;
    let flag = heur.is_garbage;
    if (!flag) {
      // Structural rule — only meaningful when the entity is not
      // brand-new (otherwise the crawler may still be writing joins).
      const orphan = await isStructurallyOrphan(env, r.id, { minAgeHours: 24 });
      if (orphan.orphan) { flag = true; reasons = orphan.reasons; }
    }
    if (!flag) continue;
    flagged += 1;
    for (const code of reasons) byReason[code] = (byReason[code] ?? 0) + 1;
    try {
      await softDeleteEntity(env, r.id, reasons, source, opts.actorEmail ?? null);
      softDeleted += 1;
    } catch (e) {
      console.warn("sweep soft-delete failed", r.id, (e as Error).message);
    }
  }

  const result: SweepResult = {
    scanned: items.length, flagged, soft_deleted: softDeleted,
    by_reason: byReason, bounded: items.length >= limit,
  };
  console.log("garbage.cleanup_sweep", JSON.stringify({ mode, ...result }));
  return result;
}
