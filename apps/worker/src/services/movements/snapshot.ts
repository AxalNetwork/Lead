// Task #2: weekly firm team-page snapshot.
//
// For each firm entity with a `firm.team_url` fact, fetch the team page
// through the existing tiered fetcher, parse via venturePartnerListings,
// normalize to a stable {name, role_title, profile_url, slug} list, and
// write one append-only row to firm_team_snapshots. Idempotent on
// (firm_entity_id, snapshot_date) so a re-tick in the same day is a no-op.

import type { Env } from "../../types";
import { crawlerFetch } from "../../crawler/fetcher";
import { pickAdapter } from "../../crawler/adapters";
import { venturePartnerListings } from "../../crawler/adapters/venturePartnerListings";
import type { AdapterResult } from "../../crawler/adapters/types";
import { canonicalLinkedin } from "../../entities/normalize";
import { createEntity, addRole } from "../../entities/roles";

export interface SnapshotMember {
  entity_id?: string | null;
  name: string;
  role_title?: string | null;
  profile_url?: string | null;
  slug?: string | null;
}

export interface SnapshotResult {
  firm_entity_id: string;
  snapshot_date: string;
  inserted: boolean;
  members_count: number;
  reason?: string;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function slugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? null;
  } catch { return null; }
}

export async function snapshotFirm(
  env: Env,
  firmEntityId: string,
  teamUrl: string,
  opts: { snapshotDate?: string } = {},
): Promise<SnapshotResult> {
  const snapshot_date = opts.snapshotDate ?? new Date().toISOString().slice(0, 10);

  // Idempotency guard: if today's snapshot already exists, do nothing.
  const existing = await env.DB.prepare(
    `SELECT id FROM firm_team_snapshots WHERE firm_entity_id = ? AND snapshot_date = ?`,
  ).bind(firmEntityId, snapshot_date).first<{ id: string }>();
  if (existing) {
    return { firm_entity_id: firmEntityId, snapshot_date, inserted: false, members_count: 0, reason: "already_snapshotted" };
  }

  const fetched = await crawlerFetch(env, teamUrl);
  const members: SnapshotMember[] = [];
  let reason: string | null = null;
  let parsedAdapterId: string | null = null;

  if (!fetched.ok || !fetched.html) {
    reason = `fetch_failed:${fetched.error ?? fetched.status}`;
  } else {
    // Adapter selection: try firm-specific adapter via pickAdapter first
    // (e.g. linkedinPublic, governmentRosters, …); fall back to the
    // generic venturePartnerListings team-page parser.
    const finalUrl = fetched.finalUrl || teamUrl;
    let parsed: AdapterResult | null = null;
    const specific = pickAdapter(finalUrl);
    if (specific && specific.id !== "venture_partner_listings") {
      try { parsed = specific.extract(fetched.html, finalUrl, {}); parsedAdapterId = specific.id; }
      catch (e) { console.warn("firm adapter failed", specific.id, (e as Error).message); }
    }
    if (!parsed || (parsed.candidates ?? []).length === 0) {
      try { parsed = venturePartnerListings.extract(fetched.html, finalUrl); parsedAdapterId = "venture_partner_listings"; }
      catch (e) { console.warn("venturePartnerListings failed", (e as Error).message); }
    }

    const seen = new Set<string>();
    for (const cand of parsed?.candidates ?? []) {
      const name = (cand.name ?? "").trim();
      if (!name) continue;
      const key = normName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const data = (cand.data ?? {}) as { role?: string | null; profile_url?: string | null };
      const profile_url = cand.url ?? data.profile_url ?? null;
      // Resolve (or mint) a canonical person entity so downstream
      // movements, corroboration, and timelines all link by id, not
      // just by name. Linkedin URL is the strongest dedupe key;
      // otherwise we fall back to normalized name within the same
      // firm to avoid two snapshots of the same team minting twins.
      const entity_id = await resolvePersonEntity(env, {
        name, profile_url, person_norm: key, firm_entity_id: firmEntityId,
      });
      members.push({
        entity_id,
        name,
        role_title: data.role ?? null,
        profile_url,
        slug: slugFromUrl(profile_url),
      });
    }
    if (!members.length) reason = "no_members_parsed";
  }

  // Append-only contract: ALWAYS write a row per eligible firm per
  // sweep, even when parse yields zero members. That keeps the
  // diffability invariant (every weekly cadence has a row) and lets
  // ops surface "team page broke" via members_count=0. members_json
  // stays a flat array (consumers depend on that shape); the parser
  // diagnostic is logged but not persisted to that column.
  if (!members.length) {
    console.warn("firm_team_snapshot empty", JSON.stringify({
      firm_entity_id: firmEntityId, snapshot_date, reason,
      parsed_with: parsedAdapterId, source_url: teamUrl,
    }));
  }
  try {
    await env.DB.prepare(
      `INSERT INTO firm_team_snapshots
         (id, firm_entity_id, snapshot_date, source_url, members_json, members_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), firmEntityId, snapshot_date,
      teamUrl, JSON.stringify(members), members.length,
    ).run();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      return { firm_entity_id: firmEntityId, snapshot_date, inserted: false, members_count: 0, reason: "race_already_snapshotted" };
    }
    throw e;
  }

  return {
    firm_entity_id: firmEntityId, snapshot_date,
    inserted: true, members_count: members.length,
    reason: reason ?? undefined,
  };
}

/**
 * Resolve (or mint) a canonical person entity for a parsed team
 * member. Linkedin canonical key wins; otherwise we dedupe on
 * (person_norm, firm_entity_id) by walking past snapshots so two
 * weeks of "Jane Smith" at Sequoia map to the same person, not two.
 * Newly minted persons get the `investor` role since they were found
 * on a firm team page.
 */
async function resolvePersonEntity(env: Env, args: {
  name: string; profile_url: string | null;
  person_norm: string; firm_entity_id: string;
}): Promise<string | null> {
  // 1. Linkedin canonical lookup.
  const lk = canonicalLinkedin(args.profile_url);
  if (lk) {
    const r = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_linkedin_key = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(lk).first<{ id: string }>();
    if (r?.id) return r.id;
  }
  // 2. Same-firm prior snapshot lookup: find a prior member row at
  //    this firm whose normalized name matches and has an entity_id.
  const prior = await env.DB.prepare(
    `SELECT members_json FROM firm_team_snapshots
      WHERE firm_entity_id = ?
      ORDER BY snapshot_date DESC LIMIT 10`,
  ).bind(args.firm_entity_id).all<{ members_json: string }>();
  for (const row of prior.results ?? []) {
    try {
      const arr = JSON.parse(row.members_json) as Array<{ name?: string; entity_id?: string | null }>;
      for (const m of arr) {
        if (!m?.entity_id || !m?.name) continue;
        if (normName(m.name) === args.person_norm) return m.entity_id;
      }
    } catch { /* skip malformed */ }
  }
  // 3. Mint a new person entity. Mark suppressAutoProfileFill via the
  //    org path? createEntity only auto-fills orgs; persons trigger the
  //    persona match refresh which is what we want.
  try {
    const created = await createEntity(env, {
      kind: "person",
      display_name: args.name,
      primary_url: args.profile_url ?? null,
      primary_linkedin_key: lk ?? null,
    });
    if (!created) return null; // Task #9: rejected by garbage detector
    await addRole(env, created.id, "investor", { source: "movements:firm_team_snapshot" });
    return created.id;
  } catch (e) {
    console.warn("resolvePersonEntity create failed", args.name, (e as Error).message);
    return null;
  }
}

/**
 * Sweep enabled firms that need a weekly snapshot (last snapshot older
 * than 7 days, or never snapshotted). Bounded by `limit` so a single
 * tick fits well inside the hourly cron budget.
 *
 * A firm is eligible when it has a current `firm.team_url` fact pointing
 * at the canonical team page and an `investor_firm`-style role.
 */
export async function runWeeklySnapshotSweep(env: Env, limit = 25): Promise<{
  picked: number;
  inserted: number;
  skipped: number;
  errors: number;
}> {
  const out = { picked: 0, inserted: 0, skipped: 0, errors: 0 };

  // Pick up to `limit` firms whose team_url fact exists and whose most
  // recent snapshot is missing or >7 days old. We left-join on the
  // most-recent snapshot date and filter via HAVING-equivalent.
  // Deterministic team-url tie-break: when an entity has more than
  // one current `firm.team_url` fact, pick the most recently observed
  // (then created) row so the crawl target is stable across runs.
  const rows = await env.DB.prepare(
    `WITH picked AS (
       SELECT f.entity_id AS firm_entity_id, f.value_text AS team_url,
              ROW_NUMBER() OVER (
                PARTITION BY f.entity_id
                ORDER BY f.observed_at DESC, f.created_at DESC, f.id ASC
              ) AS rn
         FROM facts f
         JOIN entity_roles r ON r.entity_id = f.entity_id
                            AND r.role = 'investor_firm'
        WHERE f.predicate = 'firm.team_url'
          AND f.is_current = 1
          AND f.value_text IS NOT NULL
          AND f.value_text <> ''
     ),
     dated AS (
       SELECT p.firm_entity_id, p.team_url,
              (SELECT MAX(snapshot_date) FROM firm_team_snapshots s
                WHERE s.firm_entity_id = p.firm_entity_id) AS last_date
         FROM picked p
        WHERE p.rn = 1
     )
     SELECT firm_entity_id, team_url, last_date
       FROM dated
      WHERE last_date IS NULL OR last_date < date('now','-7 days')
      ORDER BY (last_date IS NULL) DESC, last_date ASC
      LIMIT ?`,
  ).bind(limit).all<{ firm_entity_id: string; team_url: string; last_date: string | null }>();

  const list = rows.results ?? [];
  out.picked = list.length;
  for (const row of list) {
    try {
      const r = await snapshotFirm(env, row.firm_entity_id, row.team_url);
      if (r.inserted) out.inserted += 1;
      else out.skipped += 1;
    } catch (e) {
      out.errors += 1;
      console.warn("snapshotFirm failed", row.firm_entity_id, (e as Error).message);
    }
  }
  return out;
}
