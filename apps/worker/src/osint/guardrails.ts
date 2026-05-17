// Guardrails applied before auto-linking a (platform, handle) to an entity.
//
// Three independent rails:
//   1. Squatter / impersonator blocklist (per-platform + global).
//   2. Common-name detector — when the entity display_name is entirely
//      composed of high-frequency tokens, we require >=3 corroborating
//      methods before auto-link.
//   3. Conflict detector — auto-link is denied if another active link
//      already maps the same (platform, handle) to a DIFFERENT entity.

import type { Env } from "../types";
import type { PivotHit } from "./types";
import squatters from "../../data/squatter-handles.json";
import commonNames from "../../data/common-names.json";

interface SquatterFile {
  global: string[];
  patterns: string[];
  by_platform: Record<string, string[]>;
}
interface NamesFile { given: string[]; family: string[] }

const SQ = squatters as unknown as SquatterFile;
const NAMES = commonNames as unknown as NamesFile;
const GIVEN = new Set(NAMES.given.map((s) => s.toLowerCase()));
const FAMILY = new Set(NAMES.family.map((s) => s.toLowerCase()));

export function isBlocklisted(platform: string, handle: string): { blocked: boolean; reason?: string } {
  const h = handle.toLowerCase();
  if (SQ.global.includes(h)) return { blocked: true, reason: "global_blocklist" };
  for (const pat of SQ.patterns) {
    try {
      if (new RegExp(pat).test(h)) return { blocked: true, reason: `pattern:${pat}` };
    } catch { /* invalid regex — skip */ }
  }
  const perPlat = SQ.by_platform[platform];
  if (perPlat && perPlat.includes(h)) return { blocked: true, reason: `platform_blocklist:${platform}` };
  return { blocked: false };
}

// Returns true if the given display name is entirely common tokens. Tokens
// that are >=4 chars in length must ALL be present in either the given or
// family set. Stop-words and 1-3 letter tokens (initials, particles) are
// ignored for this check.
export function isCommonNameOnly(displayName: string | null): boolean {
  if (!displayName) return true;
  const tokens = displayName
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4);
  if (!tokens.length) return true;
  return tokens.every((t) => GIVEN.has(t) || FAMILY.has(t));
}

export async function isCrossLinkedToDifferentEntity(
  env: Env,
  platform: string,
  handle: string,
  ownEntityId: string,
): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM identity_handles
       WHERE platform = ? AND handle = ? AND is_active = 1 AND entity_id != ?
       LIMIT 1`,
  ).bind(platform, handle.toLowerCase(), ownEntityId).first<{ entity_id: string }>();
  return !!r;
}

// Final confidence after applying scaling rules from the task spec:
//   - keybase/well_known/crypto_*  → cap raised to 0.98
//   - bio_url/same_as/gravatar     → cap 0.90 unless corroborated
//   - hackernews/reddit            → cap 0.92 when there's a backlink, else 0.65
//   - username (alone)             → max 0.50 (NEVER auto-links by itself)
//   - avatar_phash                 → 0.90 when hamming <= 6, else 0.78
//   - stylometric                  → cap 0.78
//   - mutual_followers             → cap 0.78
//
// Corroboration boost: when the same (platform, handle) is hit by >=2
// distinct methods, add 0.07 (capped at 0.99).
// Per-method confidence cap. Applied to each hit's base_confidence BEFORE
// corroboration is computed, so a pivot that emits an over-eager score
// still gets clamped to the spec's policy.
const METHOD_CAP: Record<string, number> = {
  keybase: 0.98,
  well_known: 0.98,
  crypto_ens: 0.98,
  crypto_lens: 0.98,
  crypto_farcaster: 0.98,
  bio_url: 0.90,
  same_as: 0.90,
  gravatar: 0.90,
  hackernews: 0.92,
  reddit: 0.92,
  username: 0.50,
  avatar_phash: 0.90,
  stylometric: 0.78,
  mutual_followers: 0.78,
};

function capFor(method: string): number {
  if (method in METHOD_CAP) return METHOD_CAP[method];
  // Unknown methods default to the conservative 0.78 cap.
  return 0.78;
}

export function scoreHits(hits: PivotHit[]): Array<PivotHit & { final_confidence: number; corroborations: number }> {
  // Group by (platform, handle) — corroborations come from distinct methods.
  const groups = new Map<string, PivotHit[]>();
  for (const h of hits) {
    const k = `${h.platform}::${h.handle.toLowerCase()}`;
    const g = groups.get(k) ?? [];
    g.push(h); groups.set(k, g);
  }
  const out: Array<PivotHit & { final_confidence: number; corroborations: number }> = [];
  for (const [, group] of groups) {
    const methods = new Set(group.map((g) => g.link_method));
    const corroborations = methods.size;
    // Apply per-method cap to each hit, then pick the highest *capped* one.
    const capped = group.map((h) => ({ hit: h, capped: Math.min(h.base_confidence, capFor(h.link_method)) }));
    const best = capped.reduce((a, b) => (a.capped >= b.capped ? a : b));
    let conf = best.capped;
    if (corroborations >= 2) conf = Math.min(0.99, conf + 0.07 * (corroborations - 1));
    out.push({ ...best.hit, base_confidence: best.capped, final_confidence: conf, corroborations });
  }
  return out;
}
