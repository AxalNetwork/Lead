// Task #2: weekly firm team-page snapshot.
//
// For each firm entity with a `firm.team_url` fact, fetch the team page
// through the existing tiered fetcher, parse via venturePartnerListings,
// normalize to a stable {name, role_title, profile_url, slug} list, and
// write one append-only row to firm_team_snapshots. Idempotent on
// (firm_entity_id, snapshot_date) so a re-tick in the same day is a no-op.

import type { Env } from "../../types";
import { crawlerFetch } from "../../crawler/fetcher";
import { venturePartnerListings } from "../../crawler/adapters/venturePartnerListings";

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
  if (!fetched.ok || !fetched.html) {
    return { firm_entity_id: firmEntityId, snapshot_date, inserted: false, members_count: 0, reason: `fetch_failed:${fetched.error ?? fetched.status}` };
  }

  const parsed = venturePartnerListings.extract(fetched.html, fetched.finalUrl || teamUrl);
  const members: SnapshotMember[] = [];
  const seen = new Set<string>();
  for (const cand of parsed.candidates ?? []) {
    const name = (cand.name ?? "").trim();
    if (!name) continue;
    const key = normName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const data = (cand.data ?? {}) as { role?: string | null; profile_url?: string | null };
    members.push({
      name,
      role_title: data.role ?? null,
      profile_url: cand.url ?? data.profile_url ?? null,
      slug: slugFromUrl(cand.url ?? null),
    });
  }

  if (!members.length) {
    return { firm_entity_id: firmEntityId, snapshot_date, inserted: false, members_count: 0, reason: "no_members_parsed" };
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

  return { firm_entity_id: firmEntityId, snapshot_date, inserted: true, members_count: members.length };
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
  const rows = await env.DB.prepare(
    `SELECT f.entity_id AS firm_entity_id, f.value_text AS team_url,
            (SELECT MAX(snapshot_date) FROM firm_team_snapshots s WHERE s.firm_entity_id = f.entity_id) AS last_date
       FROM facts f
       JOIN entity_roles r ON r.entity_id = f.entity_id
                          AND r.role IN ('investor_firm','firm','vc','gp','investor')
      WHERE f.predicate = 'firm.team_url'
        AND f.is_current = 1
        AND f.value_text IS NOT NULL
        AND f.value_text <> ''
      GROUP BY f.entity_id
      HAVING last_date IS NULL OR last_date < date('now','-7 days')
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
