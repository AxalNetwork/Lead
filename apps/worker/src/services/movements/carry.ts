// Task #2: carry-economics heuristic.
//
// Inputs:
//   - Item 7 profit-sharing-eligible employee count from the firm's most
//     recent Form ADV (sec_filings.parsed_payload_json — written by the
//     EDGAR persist layer).
//   - Current partner count from the firm's latest firm_team_snapshots
//     row (counting members whose role_title matches partner/GP/MD).
//
// Output:
//   - `carry_breadth` fact on the firm entity, stamped through
//     insertFact (canonical write path). One of:
//       broad         — profit-sharing-eligible ≥ partner count
//       concentrated  — profit-sharing-eligible < half of partner count
//       unknown       — either side missing
//   - Always stamped with `{heuristic: true, source_urls: [...]}` so
//     the dashboard can distinguish from corroborated facts.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";

const PARTNER_TITLE_RE = /\b(partner|gp|general partner|managing director|managing partner)\b/i;

interface SnapshotRow {
  members_json: string;
  source_url: string;
}

interface AdvRow {
  parsed_payload_json: string | null;
  filing_url: string | null;
  filed_at: string | null;
}

interface AdvPayloadShape {
  profit_sharing_eligible?: number | null;
  // Some ADV parses store it under nested item7. Tolerate both shapes.
  item_7?: { profit_sharing_eligible?: number | null } | null;
  employee_count?: number | null;
}

function readEligibleCount(payload: AdvPayloadShape | null): number | null {
  if (!payload) return null;
  if (typeof payload.profit_sharing_eligible === "number") return payload.profit_sharing_eligible;
  if (payload.item_7 && typeof payload.item_7.profit_sharing_eligible === "number") {
    return payload.item_7.profit_sharing_eligible;
  }
  return null;
}

export interface CarryResult {
  firm_entity_id: string;
  breadth: "broad" | "concentrated" | "unknown";
  partner_count: number | null;
  profit_sharing_eligible: number | null;
  source_urls: string[];
}

export async function computeCarryBreadth(env: Env, firmEntityId: string): Promise<CarryResult> {
  const sources: string[] = [];

  // 1. Partner count from latest team snapshot.
  let partner_count: number | null = null;
  const snap = await env.DB.prepare(
    `SELECT members_json, source_url
       FROM firm_team_snapshots
      WHERE firm_entity_id = ?
      ORDER BY snapshot_date DESC LIMIT 1`,
  ).bind(firmEntityId).first<SnapshotRow>();
  if (snap) {
    try {
      const members = JSON.parse(snap.members_json) as Array<{ role_title?: string | null }>;
      partner_count = members.filter((m) => PARTNER_TITLE_RE.test(m.role_title ?? "")).length;
      if (snap.source_url) sources.push(snap.source_url);
    } catch { /* leave null */ }
  }

  // 2. Profit-sharing-eligible from latest ADV filing.
  let profit_sharing_eligible: number | null = null;
  const adv = await env.DB.prepare(
    `SELECT parsed_payload_json, filing_url, filed_at
       FROM sec_filings
      WHERE entity_id = ?
        AND upper(form_type) IN ('ADV','FORM ADV','ADV/A')
        AND ingest_status = 'parsed'
      ORDER BY filed_at DESC LIMIT 1`,
  ).bind(firmEntityId).first<AdvRow>();
  if (adv?.parsed_payload_json) {
    try {
      const payload = JSON.parse(adv.parsed_payload_json) as AdvPayloadShape;
      profit_sharing_eligible = readEligibleCount(payload);
      if (adv.filing_url) sources.push(adv.filing_url);
    } catch { /* leave null */ }
  }

  let breadth: "broad" | "concentrated" | "unknown" = "unknown";
  if (partner_count != null && partner_count > 0 && profit_sharing_eligible != null) {
    if (profit_sharing_eligible >= partner_count) breadth = "broad";
    else if (profit_sharing_eligible < Math.ceil(partner_count / 2)) breadth = "concentrated";
    else breadth = "unknown";
  }

  // Stamp through the canonical write path. evidence_url is the snapshot
  // URL when present, otherwise the ADV filing URL.
  const evidence = sources[0] ?? null;
  await insertFact(env, {
    entity_id: firmEntityId,
    predicate: "firm.carry_breadth",
    value_text: breadth,
    value_json: {
      heuristic: true,
      partner_count,
      profit_sharing_eligible,
      source_urls: sources,
    },
    source_kind: "enrichment",
    source: "movements:carry_heuristic",
    evidence_url: evidence,
    confidence: 0.6,
  });

  return { firm_entity_id: firmEntityId, breadth, partner_count, profit_sharing_eligible, source_urls: sources };
}

export async function runCarrySweep(env: Env, limit = 50): Promise<{ firms: number }> {
  // Anti-starvation: order by the AGE of the firm's last
  // `firm.carry_breadth` fact, oldest (or never-stamped) first.
  // Firms with no carry_breadth fact yet sort to the top via the
  // COALESCE to '0000-01-01'. Round-robin coverage across all firms
  // emerges naturally as recently-stamped firms drop to the bottom
  // of the queue for ~24h.
  const rows = await env.DB.prepare(
    `SELECT s.firm_entity_id,
            COALESCE(MAX(f.observed_at), '0000-01-01') AS last_stamp
       FROM firm_team_snapshots s
       LEFT JOIN facts f
              ON f.entity_id = s.firm_entity_id
             AND f.predicate = 'firm.carry_breadth'
             AND f.is_current = 1
      GROUP BY s.firm_entity_id
      ORDER BY last_stamp ASC, s.firm_entity_id ASC
      LIMIT ?`,
  ).bind(limit).all<{ firm_entity_id: string; last_stamp: string }>();
  let firms = 0;
  for (const r of rows.results ?? []) {
    try {
      await computeCarryBreadth(env, r.firm_entity_id);
      firms += 1;
    } catch (e) {
      console.warn("computeCarryBreadth failed", r.firm_entity_id, (e as Error).message);
    }
  }
  return { firms };
}
