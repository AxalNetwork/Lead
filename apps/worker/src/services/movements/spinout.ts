// Task #2: fund-spinout detector.
//
// On every confirmed `left` we re-evaluate the parent firm's 90-day
// departure cluster. If ≥2 confirmed `left` events share a
// from_firm_entity_id within a 90-day window, and a new entity with
// `role IN ('investor_firm','firm','vc')` appears whose most-recent
// team snapshot lists ≥2 of those departing people, emit a
// `fund_spinouts` row and enqueue a watchlist notification.

import type { Env } from "../../types";
import { sha256 } from "../../entities/normalize";

interface LeftRow {
  id: string;
  person_entity_id: string | null;
  person_name_raw: string;
  person_name_normalized: string;
  observed_at: string;
  source_url: string | null;
}

interface CandidateFirm {
  firm_entity_id: string;
  team_url: string;
  snapshot_date: string;
  members_json: string;
}

interface SpinoutNotificationPayload {
  spinout_id: string;
  parent_firm_entity_id: string;
  new_firm_entity_id: string | null;
  new_firm_name: string | null;
  people: string[];
}

async function enqueueWatchlistNotification(env: Env, payload: SpinoutNotificationPayload): Promise<void> {
  // Best-effort: use alert_events as the platform's general notification
  // surface (mirrors how crawler-drift uses it in scheduled.ts). Each
  // spinout gets a deterministic id derived from spinout_id so re-runs
  // are idempotent.
  const owner = (env.ALLOWED_EMAIL || "system:movements").split(",")[0].trim().toLowerCase();
  const hash = await sha256(`spinout|${payload.spinout_id}`);
  const id = `spinout:${hash.slice(0, 32)}`;
  try {
    await env.DB.prepare(
      `INSERT INTO alert_events
         (id, owner_email, rule_id, watchlist_id, entity_id, trigger_kind,
          dedupe_key, dedupe_hash, title, body, payload_json, channel,
          delivery_status, occurred_at)
       VALUES (?, ?, 'system:fund-spinout', NULL, ?, 'executive_change',
               ?, ?, ?, ?, ?, 'in_app', 'delivered', datetime('now'))
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      id, owner,
      payload.new_firm_entity_id ?? payload.parent_firm_entity_id,
      payload.spinout_id, hash,
      `Fund spinout: ${payload.new_firm_name ?? "new firm"} (from parent ${payload.parent_firm_entity_id})`,
      `${payload.people.length} partners departed: ${payload.people.slice(0, 6).join(", ")}`,
      // payload.subkind="fund_spinout" preserves the real notification
      // semantics inside the alert_rules-allowed `executive_change`
      // trigger_kind envelope. UI filters on payload.subkind to render
      // these as fund spinouts. Avoids needing a SQLite table-rebuild
      // migration to extend the alert_rules CHECK enum.
      JSON.stringify({ subkind: "fund_spinout", ...payload }),
    ).run();
  } catch (e) {
    console.warn("spinout notification insert failed", (e as Error).message);
  }
}

/**
 * Evaluate the cluster of `left` events for a parent firm.
 *
 * Looks for a candidate new firm by scanning the most recent
 * firm_team_snapshots row of every OTHER firm and intersecting the
 * member list with our departing-people set.
 */
export async function detectSpinoutsForFirm(env: Env, parentFirmEntityId: string): Promise<{
  windows_evaluated: number;
  spinouts_emitted: number;
}> {
  const out = { windows_evaluated: 0, spinouts_emitted: 0 };

  // Pull every confirmed `left` from this parent in the last 180 days
  // so we can slide a 90-day window.
  const leftRows = await env.DB.prepare(
    `SELECT id, person_entity_id, person_name_raw, person_name_normalized,
            observed_at, source_url
       FROM partner_movements
      WHERE from_firm_entity_id = ?
        AND movement_type = 'left'
        AND status = 'confirmed'
        AND observed_at >= date('now','-180 day')
      ORDER BY observed_at ASC`,
  ).bind(parentFirmEntityId).all<LeftRow>();
  const lefts = leftRows.results ?? [];
  if (lefts.length < 2) return out;

  // 90-day sliding window. We anchor on each `left` and gather every
  // departure within +90d of that anchor. Any window with ≥2 entries
  // becomes a candidate cluster.
  const anchored: Array<{ window_start: string; window_end: string; people: LeftRow[] }> = [];
  for (let i = 0; i < lefts.length; i++) {
    const anchor = lefts[i];
    const windowEndMs = new Date(anchor.observed_at).getTime() + 90 * 24 * 60 * 60 * 1000;
    const cluster = [anchor];
    for (let j = i + 1; j < lefts.length; j++) {
      const t = new Date(lefts[j].observed_at).getTime();
      if (t <= windowEndMs) cluster.push(lefts[j]);
      else break;
    }
    if (cluster.length >= 2) {
      anchored.push({
        window_start: anchor.observed_at,
        window_end: cluster[cluster.length - 1].observed_at,
        people: cluster,
      });
    }
  }
  out.windows_evaluated = anchored.length;
  if (!anchored.length) return out;

  // Largest cluster first — we want to emit at most one spinout per
  // run for the biggest meaningful cluster.
  anchored.sort((a, b) => b.people.length - a.people.length);

  for (const window of anchored) {
    const personNames = window.people.map((p) => p.person_name_normalized).filter(Boolean);
    if (personNames.length < 2) continue;

    // Scan recent snapshots for a NEWLY EMERGED firm whose member list
    // intersects with our departing-people set by ≥2. "Newly emerged"
    // = u_entities.created_at within the departure window's
    // [window_start - 30d, window_end + 180d] envelope. This rejects
    // normal multi-person lateral moves to long-established firms.
    const earliest = window.window_start;
    const latest = window.window_end;
    const otherFirms = await env.DB.prepare(
      `SELECT s.firm_entity_id, s.source_url AS team_url, s.snapshot_date, s.members_json
         FROM firm_team_snapshots s
         JOIN (
           SELECT firm_entity_id, MAX(snapshot_date) AS max_date
             FROM firm_team_snapshots
            GROUP BY firm_entity_id
         ) latest ON latest.firm_entity_id = s.firm_entity_id AND latest.max_date = s.snapshot_date
         JOIN u_entities e ON e.id = s.firm_entity_id
         JOIN entity_roles r ON r.entity_id = s.firm_entity_id
                            AND r.role IN ('investor_firm','firm','vc','gp','investor')
        WHERE s.firm_entity_id <> ?
          AND s.snapshot_date >= ?
          AND date(e.created_at) >= date(?, '-30 day')
          AND date(e.created_at) <= date(?, '+180 day')`,
    ).bind(parentFirmEntityId, latest, earliest, latest).all<CandidateFirm>();

    let chosen: CandidateFirm | null = null;
    let chosenIntersection: string[] = [];
    for (const cf of otherFirms.results ?? []) {
      let members: Array<{ name?: string }> = [];
      try { members = JSON.parse(cf.members_json) as Array<{ name?: string }>; } catch { continue; }
      const memberNorms = new Set(
        members
          .map((m) => (m.name ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );
      const overlap = personNames.filter((n) => memberNorms.has(n));
      if (overlap.length >= 2 && overlap.length > chosenIntersection.length) {
        chosen = cf;
        chosenIntersection = overlap;
      }
    }
    if (!chosen) continue;

    const sortedNorms = [...personNames].sort();
    const dedupe_key = await sha256(`spinout|${parentFirmEntityId}|${sortedNorms.join(",")}`);
    const spinout_id = crypto.randomUUID();
    const sourceUrls = Array.from(new Set([
      ...window.people.map((p) => p.source_url).filter((x): x is string => !!x),
      chosen.team_url,
    ]));
    const departingPayload = window.people.map((p) => ({
      person_entity_id: p.person_entity_id,
      name: p.person_name_raw,
    }));

    let newFirmName: string | null = null;
    try {
      const fn = await env.DB.prepare(
        `SELECT display_name FROM u_entities WHERE id = ?`,
      ).bind(chosen.firm_entity_id).first<{ display_name: string | null }>();
      newFirmName = fn?.display_name ?? null;
    } catch { /* best-effort */ }

    try {
      await env.DB.prepare(
        `INSERT INTO fund_spinouts (
           id, parent_firm_entity_id, new_firm_entity_id, new_firm_name,
           departing_people_json, window_start, window_end, source_urls_json,
           status, dedupe_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?)`,
      ).bind(
        spinout_id, parentFirmEntityId, chosen.firm_entity_id, newFirmName,
        JSON.stringify(departingPayload), window.window_start, window.window_end,
        JSON.stringify(sourceUrls), dedupe_key,
      ).run();
      out.spinouts_emitted += 1;
      await enqueueWatchlistNotification(env, {
        spinout_id,
        parent_firm_entity_id: parentFirmEntityId,
        new_firm_entity_id: chosen.firm_entity_id,
        new_firm_name: newFirmName,
        people: window.people.map((p) => p.person_name_raw),
      });
    } catch (e) {
      const msg = (e as Error).message || "";
      if (!/UNIQUE/i.test(msg)) {
        console.warn("fund_spinouts insert failed", (e as Error).message);
      }
    }
    // Emit at most one spinout per run per parent.
    break;
  }
  return out;
}

/**
 * Sweep every parent firm that produced a confirmed `left` in the last
 * 90 days. Bounded by `limit`.
 */
export async function runSpinoutSweep(env: Env, limit = 50): Promise<{
  firms: number;
  spinouts_emitted: number;
}> {
  const out = { firms: 0, spinouts_emitted: 0 };
  const rows = await env.DB.prepare(
    `SELECT DISTINCT from_firm_entity_id AS firm_id
       FROM partner_movements
      WHERE movement_type = 'left'
        AND status = 'confirmed'
        AND from_firm_entity_id IS NOT NULL
        AND observed_at >= date('now','-90 day')
      LIMIT ?`,
  ).bind(limit).all<{ firm_id: string }>();
  for (const r of rows.results ?? []) {
    try {
      const res = await detectSpinoutsForFirm(env, r.firm_id);
      out.firms += 1;
      out.spinouts_emitted += res.spinouts_emitted;
    } catch (e) {
      console.warn("detectSpinoutsForFirm failed", r.firm_id, (e as Error).message);
    }
  }
  return out;
}
