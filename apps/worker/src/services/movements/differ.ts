// Task #2: snapshot differ.
//
// Diffs the last two snapshots for a firm and emits candidate
// partner_movements rows. Status starts as 'provisional'; the
// corroboration layer is what promotes them.
//
// Flicker suppression contract: `left` requires TWO consecutive
// confirming snapshots — that is, the person must be missing from
// the most recent snapshot AND the one before it, while being present
// in the snapshot before that. A single missed snapshot never emits
// a `left`. `joined`, `promoted`, and `title_change` need only one
// new snapshot.

import type { Env } from "../../types";
import { sha256 } from "../../entities/normalize";
import { insertFact } from "../../entities/facts";
import { compareTitles } from "./seniority";
import type { SnapshotMember } from "./snapshot";

export type MovementType = "joined" | "left" | "promoted" | "title_change";

interface SnapshotRow {
  id: string;
  firm_entity_id: string;
  snapshot_date: string;
  source_url: string;
  members_json: string;
  members_count: number;
}

export interface DiffResult {
  firm_entity_id: string;
  compared: [string, string] | null;   // [prev_date, current_date]
  emitted: number;
  skipped_flicker: number;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function monthBucket(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 7); // YYYY-MM
}

function parseMembers(json: string): SnapshotMember[] {
  try {
    const arr = JSON.parse(json) as SnapshotMember[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function memberKey(x: SnapshotMember): string {
  // Identity key: prefer the resolved entity_id when the snapshotter
  // attached one (distinct same-name partners stay distinct across
  // snapshots), fall back to normalized name only when no canonical
  // person entity is bound. Each snapshot resolves the same physical
  // person to the same entity_id via resolvePersonEntity, so keying on
  // it is stable across current/prev/prevPrev.
  if (x.entity_id) return `id:${x.entity_id}`;
  const n = normName(x.name);
  return n ? `n:${n}` : "";
}

function indexByName(members: SnapshotMember[]): Map<string, SnapshotMember> {
  const m = new Map<string, SnapshotMember>();
  for (const x of members) {
    const k = memberKey(x);
    if (k) m.set(k, x);
  }
  return m;
}

async function dedupeKeyFor(args: {
  person_norm: string;
  movement_type: MovementType;
  from_firm: string | null;
  to_firm: string | null;
  month: string;
}): Promise<string> {
  return sha256(
    `${args.person_norm}|${args.movement_type}|${args.from_firm ?? ""}|${args.to_firm ?? ""}|${args.month}`,
  );
}

async function insertMovement(
  env: Env,
  args: {
    person_entity_id: string | null;
    person_name_raw: string;
    person_norm: string;
    from_firm_entity_id: string | null;
    to_firm_entity_id: string | null;
    from_title: string | null;
    to_title: string | null;
    movement_type: MovementType;
    observed_at: string;
    source_url: string;
  },
): Promise<boolean> {
  const month = monthBucket(args.observed_at);
  const dedupe_key = await dedupeKeyFor({
    person_norm: args.person_norm,
    movement_type: args.movement_type,
    from_firm: args.from_firm_entity_id,
    to_firm: args.to_firm_entity_id,
    month,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO partner_movements (
         id, person_entity_id, person_name_raw, person_name_normalized,
         from_firm_entity_id, to_firm_entity_id, from_title, to_title,
         movement_type, observed_at, source_url,
         corroborated_by_count, corroboration_sources_json, status, dedupe_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'provisional', ?)`,
    ).bind(
      crypto.randomUUID(), args.person_entity_id, args.person_name_raw, args.person_norm,
      args.from_firm_entity_id, args.to_firm_entity_id, args.from_title, args.to_title,
      args.movement_type, args.observed_at, args.source_url, dedupe_key,
    ).run();
    return true;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/UNIQUE/i.test(msg)) {
      // Same move already on the books — keep the original row, no churn.
      return false;
    }
    throw e;
  }
}

/**
 * Run the diff for a single firm. Reads the most recent 3 snapshots so
 * `left` can apply 2-confirming-snapshot flicker suppression.
 */
export async function diffFirm(env: Env, firmEntityId: string): Promise<DiffResult> {
  const out: DiffResult = { firm_entity_id: firmEntityId, compared: null, emitted: 0, skipped_flicker: 0 };

  const snaps = await env.DB.prepare(
    `SELECT id, firm_entity_id, snapshot_date, source_url, members_json, members_count
       FROM firm_team_snapshots
      WHERE firm_entity_id = ?
      ORDER BY snapshot_date DESC
      LIMIT 3`,
  ).bind(firmEntityId).all<SnapshotRow>();

  const rows = snaps.results ?? [];
  if (rows.length < 2) return out;

  const [current, prev, prevPrev] = rows;
  out.compared = [prev.snapshot_date, current.snapshot_date];

  // Snapshot-quality gate: a snapshot with members_count=0 is almost
  // always a fetch/parse failure (the team page broke, returned 4xx,
  // or the adapter could not match). Diffing against it would emit
  // bulk false-positive `left` events for everyone on the real team.
  // Skip diffing entirely when current OR prev returned zero members
  // while the comparison anchor (prev/prevPrev) was non-empty. We
  // still recorded an append-only row in firm_team_snapshots for
  // observability, but it is NOT a basis for movement inference.
  if (current.members_count === 0 || prev.members_count === 0) {
    out.compared = null;
    out.skipped_flicker += 1;
    return out;
  }

  const currentMembers = indexByName(parseMembers(current.members_json));
  const prevMembers    = indexByName(parseMembers(prev.members_json));
  const prevPrevMembers = prevPrev && prevPrev.members_count > 0
    ? indexByName(parseMembers(prevPrev.members_json))
    : null;

  // joined: in current, not in prev.
  for (const [key, member] of currentMembers) {
    if (prevMembers.has(key)) continue;
    const inserted = await insertMovement(env, {
      person_entity_id: member.entity_id ?? null,
      person_name_raw: member.name,
      person_norm: normName(member.name),
      from_firm_entity_id: null,
      to_firm_entity_id: firmEntityId,
      from_title: null,
      to_title: member.role_title ?? null,
      movement_type: "joined",
      observed_at: current.snapshot_date,
      source_url: current.source_url,
    });
    if (inserted) {
      out.emitted += 1;
      if (member.entity_id) {
        try {
          await insertFact(env, {
            entity_id: member.entity_id,
            predicate: "person.current_firm",
            value_entity_id: firmEntityId,
            value_text: member.role_title ?? null,
            source_kind: "scrape",
            source: "movements:diff",
            evidence_url: current.source_url,
            confidence: 0.7,
          });
        } catch (e) { console.warn("person.current_firm fact failed", (e as Error).message); }
      }
    }
  }

  // left: 2-confirming-absence flicker suppression.
  //
  // We require the canonical pattern across three snapshots
  // [prevPrev (oldest), prev, current (newest)]:
  //   - prevPrev: member PRESENT (the last time we saw them on the team)
  //   - prev:     member ABSENT (first confirming absence)
  //   - current:  member ABSENT (second confirming absence)
  //
  // That means we must iterate `prevPrevMembers` — not `prevMembers` —
  // otherwise the leaver isn't in our iteration set on the run that
  // finally has 2 consecutive absences. A single missed snapshot
  // (prevPrev: present, prev: absent, current: present) never emits.
  // If we don't yet have a prevPrev snapshot, defer.
  if (!prevPrevMembers) {
    for (const [key] of prevMembers) {
      if (!currentMembers.has(key)) out.skipped_flicker += 1;
    }
  } else {
    for (const [key, member] of prevPrevMembers) {
      if (prevMembers.has(key) || currentMembers.has(key)) continue;
      const inserted = await insertMovement(env, {
        person_entity_id: member.entity_id ?? null,
        person_name_raw: member.name,
        person_norm: normName(member.name),
        from_firm_entity_id: firmEntityId,
        to_firm_entity_id: null,
        from_title: member.role_title ?? null,
        to_title: null,
        movement_type: "left",
        // Anchor the move at `prev.snapshot_date` — the snapshot where
        // the departure first showed up. The month_bucket in the
        // dedupe_key uses this date, so re-ticks stay idempotent.
        observed_at: prev.snapshot_date,
        source_url: prev.source_url,
      });
      if (inserted) out.emitted += 1;
    }
    // Track flicker-only absences (in prev but back/never in current)
    // for observability.
    for (const [key] of prevMembers) {
      if (!currentMembers.has(key) && !prevPrevMembers.has(key)) {
        out.skipped_flicker += 1;
      }
    }
  }

  // promoted / title_change: present in both, role differs.
  for (const [key, cur] of currentMembers) {
    const before = prevMembers.get(key);
    if (!before) continue;
    const beforeTitle = (before.role_title ?? "").trim() || null;
    const afterTitle  = (cur.role_title ?? "").trim() || null;
    if (beforeTitle === afterTitle) continue;
    if (!beforeTitle && !afterTitle) continue;
    const cmp = compareTitles(beforeTitle, afterTitle);
    const movement_type: MovementType = cmp === "promoted" ? "promoted" : "title_change";
    const inserted = await insertMovement(env, {
      person_entity_id: cur.entity_id ?? null,
      person_name_raw: cur.name,
      person_norm: normName(cur.name),
      from_firm_entity_id: firmEntityId,
      to_firm_entity_id: firmEntityId,
      from_title: beforeTitle,
      to_title: afterTitle,
      movement_type,
      observed_at: current.snapshot_date,
      source_url: current.source_url,
    });
    if (inserted) {
      out.emitted += 1;
      if (cur.entity_id && afterTitle) {
        try {
          await insertFact(env, {
            entity_id: cur.entity_id,
            predicate: "person.current_title",
            value_text: afterTitle,
            source_kind: "scrape",
            source: "movements:diff",
            evidence_url: current.source_url,
            confidence: 0.7,
          });
        } catch (e) { console.warn("person.current_title fact failed", (e as Error).message); }
      }
    }
  }

  return out;
}

/**
 * Walk every firm with ≥2 snapshots and run the diff. Bounded by limit.
 */
export async function runDiffSweep(env: Env, limit = 50): Promise<{
  firms: number;
  emitted: number;
  skipped_flicker: number;
}> {
  const out = { firms: 0, emitted: 0, skipped_flicker: 0 };
  const rows = await env.DB.prepare(
    `SELECT firm_entity_id
       FROM firm_team_snapshots
      GROUP BY firm_entity_id
      HAVING COUNT(*) >= 2
      ORDER BY MAX(snapshot_date) DESC
      LIMIT ?`,
  ).bind(limit).all<{ firm_entity_id: string }>();
  for (const r of rows.results ?? []) {
    try {
      const d = await diffFirm(env, r.firm_entity_id);
      out.firms += 1;
      out.emitted += d.emitted;
      out.skipped_flicker += d.skipped_flicker;
    } catch (e) {
      console.warn("diffFirm failed", r.firm_entity_id, (e as Error).message);
    }
  }
  return out;
}
