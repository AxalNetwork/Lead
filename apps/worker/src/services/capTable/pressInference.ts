// Task #5: Press-release → cap-table inference (LOWEST confidence tier).
//
// Press releases announce: "Company X raised $Y in a Series Z round
// led by Investor A with participation from B, C, D." That gives us:
//   - one new preferred holder per investor (no shares, no pct)
//   - an approximate post-money IF the release reports valuation
//
// We bootstrap from `deal_events` rows the press-wire adapters
// (Task #3) already persisted — this avoids re-parsing the raw RSS
// and inherits the deal-corroboration logic. One snapshot per deal_event
// with `as_of = announcement_date`.

import type { Env } from "../../types";
import { persistCapTableSnapshot } from "./persist";
import type { CapTableHolderInput, CapTableSnapshotInput } from "./types";

interface DealRow {
  id: string;
  company_entity_id: string | null;
  company_name_raw: string;
  round_name: string | null;
  amount_usd: number | null;
  valuation_usd: number | null;
  valuation_type: string | null;
  announcement_date: string | null;
  closing_date: string | null;
  source_url: string;
  confidence: number;
}

interface ParticipantRow {
  investor_name_raw: string;
  role: string;
  investor_entity_id: string | null;
}

function seriesToSecurity(roundName: string | null): "preferred" | "preferred_a" | "preferred_b" | "preferred_c" | "preferred_d" | "preferred_e" | "preferred_f" | "safe" | "common" | "unknown" {
  if (!roundName) return "unknown";
  const m = /series\s+([a-f])/i.exec(roundName);
  if (m) return (`preferred_${m[1].toLowerCase()}`) as "preferred_a";
  if (/seed|pre-seed/i.test(roundName)) return "safe";
  if (/bridge|extension|safe/i.test(roundName)) return "safe";
  return "preferred";
}

export async function inferCapTableFromDeal(
  env: Env, deal_id: string,
): Promise<{ snapshot_id: string | null; skipped: boolean; reason?: string }> {
  const d = await env.DB.prepare(
    `SELECT id, company_entity_id, company_name_raw, round_name, amount_usd,
            valuation_usd, valuation_type, announcement_date, closing_date,
            source_url, confidence
       FROM deal_events WHERE id = ?`,
  ).bind(deal_id).first<DealRow>();
  if (!d) return { snapshot_id: null, skipped: true, reason: "deal_not_found" };
  const asOf = d.announcement_date ?? d.closing_date;
  if (!asOf) return { snapshot_id: null, skipped: true, reason: "no_date" };

  const parts = await env.DB.prepare(
    `SELECT investor_name_raw, role, investor_entity_id
       FROM deal_participants WHERE deal_id = ?`,
  ).bind(deal_id).all<ParticipantRow>();

  const security = seriesToSecurity(d.round_name);
  const holders: CapTableHolderInput[] = [];
  for (const p of (parts.results ?? [])) {
    holders.push({
      holder_name_raw: p.investor_name_raw,
      holder_class: "preferred_investor",
      security_type: security,
      shares: null,
      pct_ownership: null,
      original_investment_usd: null,        // press release rarely splits per-investor
      round_acquired: d.round_name ?? null,
    });
  }
  // Post-money: prefer valuation_usd; else amount_usd is a LOWER bound
  // for the round size but cannot be presented as a post-money.
  const postMoney = d.valuation_type === "post_money" ? d.valuation_usd : null;
  const preMoney = d.valuation_type === "pre_money" ? d.valuation_usd : null;

  const input: CapTableSnapshotInput = {
    company_entity_id: d.company_entity_id,
    company_name_raw: d.company_name_raw,
    as_of: asOf,
    source_kind: "press_inference",
    source_url: d.source_url,
    fully_diluted_shares: null,
    post_money_usd: postMoney,
    pre_money_usd: preMoney,
    option_pool_pct: null,
    notes: `Press inference from deal_event ${deal_id}: round=${d.round_name ?? "—"}, amount=${d.amount_usd ?? "—"}`,
    holders,
  };
  const result = await persistCapTableSnapshot(env, input);
  return { snapshot_id: result.snapshot_id, skipped: result.skipped, reason: result.reason };
}

export async function sweepPressInferenceForCompany(
  env: Env, company_entity_id: string,
): Promise<{ emitted: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT id FROM deal_events
       WHERE company_entity_id = ?
         AND event_type = 'funding_round'
       ORDER BY announcement_date ASC`,
  ).bind(company_entity_id).all<{ id: string }>();
  let emitted = 0; let skipped = 0;
  for (const r of (rows.results ?? [])) {
    const out = await inferCapTableFromDeal(env, r.id);
    if (out.snapshot_id && !out.skipped) emitted++; else skipped++;
  }
  return { emitted, skipped };
}
