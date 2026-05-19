// Task #5: Cap-Table persist layer.
//
// Single writer for `cap_table_snapshots` / `cap_table_holders`.
// Snapshots are IMMUTABLE — re-extracting the same (company, as_of,
// source_kind, source_url) is a no-op (UNIQUE constraint short-circuits
// the INSERT); a fresh re-extract on a DIFFERENT `as_of` writes a new
// row, preserving history.
//
// Side-effects on a successful new snapshot:
//   1. Resolve / mint the company entity via createEntity + addRole
//      (mirrors services/deals/persist.ts pattern).
//   2. Resolve each holder name to a u_entities row when a confident
//      match exists; mint a thin "investor" entity otherwise.
//   3. Write derived facts on the company entity via `insertFact`:
//        - cap_table.snapshot                  (one fact per snapshot)
//        - cap_table.post_money_usd            (canonical valuation)
//        - cap_table.option_pool_pct
//        - cap_table.fully_diluted_shares
//   4. Write per-holder facts on the holder entity:
//        - investor.holding_in_company         (pivot for "where else
//          does this investor appear?" queries on the profile tab)
//
// All facts route through `insertFact` per the canonical write
// decision; the predicate router (source Task #78) will swap that
// helper without changing the contract here.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";
import { normalizeHolderName } from "./normalize";
import { normalizeCompanyName } from "../deals/dedupe";
import {
  CapTableHolderInput, CapTablePersistResult, CapTableSnapshotInput,
  DEFAULT_CONFIDENCE,
} from "./types";

const SOURCE_TAG = "cap_table_inference";

async function findCompanyEntity(env: Env, c: CapTableSnapshotInput): Promise<string | null> {
  if (c.company_entity_id) return c.company_entity_id;
  // Try SEC accession_no → entity (already linked via sec_filings).
  if (c.source_accession_no) {
    const r = await env.DB.prepare(
      `SELECT entity_id FROM sec_filings WHERE accession_no = ? AND entity_id IS NOT NULL LIMIT 1`,
    ).bind(c.source_accession_no).first<{ entity_id: string }>();
    if (r?.entity_id) return r.entity_id;
  }
  // Normalized-name fallback (mirrors services/deals/persist.ts).
  const normalized = normalizeCompanyName(c.company_name_raw);
  if (normalized) {
    const r = await env.DB.prepare(
      `SELECT entity_id FROM facts
        WHERE predicate = 'company.name_normalized' AND value_text = ? AND is_current = 1
        LIMIT 1`,
    ).bind(normalized).first<{ entity_id: string }>();
    if (r?.entity_id) return r.entity_id;
  }
  return null;
}

async function ensureCompanyEntity(env: Env, c: CapTableSnapshotInput): Promise<string | null> {
  const existing = await findCompanyEntity(env, c);
  if (existing) return existing;
  if (!c.company_name_raw || c.company_name_raw.trim().length < 2) return null;
  const row = await createEntity(env, {
    kind: "org",
    display_name: c.company_name_raw.slice(0, 200),
    primary_url: null,
    primary_domain: null,
    suppressAutoProfileFill: true,
  });
  await addRole(env, row.id, "company", { is_primary: true, source: SOURCE_TAG, confidence: 0.6 });
  const normalized = normalizeCompanyName(c.company_name_raw);
  if (normalized) {
    await insertFact(env, {
      entity_id: row.id, predicate: "company.name_normalized", value_text: normalized,
      source_kind: "scrape", source: SOURCE_TAG, evidence_url: c.source_url, confidence: 0.6,
    });
  }
  return row.id;
}

async function resolveHolderEntity(env: Env, h: CapTableHolderInput): Promise<string | null> {
  const norm = normalizeHolderName(h.holder_name_raw);
  if (!norm) return null;
  // 1. fact-based investor.name_normalized index
  const f = await env.DB.prepare(
    `SELECT entity_id FROM facts
       WHERE predicate IN ('investor.name_normalized','company.name_normalized','person.name_normalized')
         AND value_text = ? AND is_current = 1
       ORDER BY confidence DESC LIMIT 1`,
  ).bind(norm).first<{ entity_id: string }>();
  if (f?.entity_id) return f.entity_id;
  // 2. ESOP/option pool rows are pseudo-holders — never minted as entities.
  if (h.holder_class === "employee_pool" || h.holder_class === "esop_unallocated") return null;
  // 3. Mint a thin entity for substantive holders so deal_history / persona
  //    matching can pivot on them. Skip natural-person founders whose names
  //    can collide with thousands of unrelated people.
  if (h.holder_class === "founder") return null;
  const kind: "org" | "person" =
    /capital|ventures?|partners|fund\b|management|investments?|holdings?|trust\b/i.test(h.holder_name_raw)
      ? "org" : "person";
  try {
    const row = await createEntity(env, {
      kind,
      display_name: h.holder_name_raw.slice(0, 200),
      primary_url: null, primary_domain: null,
      suppressAutoProfileFill: true,
    });
    await addRole(env, row.id, kind === "org" ? "investor" : "operator", {
      is_primary: true, source: SOURCE_TAG, confidence: 0.55,
    });
    await insertFact(env, {
      entity_id: row.id,
      predicate: kind === "org" ? "investor.name_normalized" : "person.name_normalized",
      value_text: norm,
      source_kind: "scrape", source: SOURCE_TAG, confidence: 0.55,
    });
    return row.id;
  } catch (e) {
    console.warn("capTable resolveHolderEntity mint failed", (e as Error).message);
    return null;
  }
}

/**
 * Persist one snapshot + its holders. Idempotent on
 * (company_entity_id, as_of, source_kind, source_url).
 */
export async function persistCapTableSnapshot(
  env: Env, input: CapTableSnapshotInput,
): Promise<CapTablePersistResult> {
  if (!input.company_name_raw || !input.as_of || !input.source_kind || !input.source_url) {
    return { snapshot_id: null, company_entity_id: null, holders_written: 0, skipped: true, reason: "missing_required" };
  }
  const companyId = await ensureCompanyEntity(env, input);
  if (!companyId) {
    return { snapshot_id: null, company_entity_id: null, holders_written: 0, skipped: true, reason: "no_company" };
  }
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE[input.source_kind] ?? 0.5;

  // Check existing snapshot first (idempotency probe).
  const existing = await env.DB.prepare(
    `SELECT id FROM cap_table_snapshots
       WHERE company_entity_id = ? AND as_of = ? AND source_kind = ? AND source_url = ?`,
  ).bind(companyId, input.as_of, input.source_kind, input.source_url).first<{ id: string }>();
  if (existing?.id) {
    return { snapshot_id: existing.id, company_entity_id: companyId, holders_written: 0, skipped: true, reason: "duplicate_snapshot" };
  }

  const snapshotId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO cap_table_snapshots (
       id, company_entity_id, company_name_raw, as_of, source_kind, source_url,
       source_accession_no, fully_diluted_shares, post_money_usd, pre_money_usd,
       option_pool_pct, preferred_pct, common_pct, confidence, raw_evidence_json, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    snapshotId, companyId, input.company_name_raw, input.as_of,
    input.source_kind, input.source_url,
    input.source_accession_no ?? null,
    input.fully_diluted_shares ?? null,
    input.post_money_usd ?? null,
    input.pre_money_usd ?? null,
    input.option_pool_pct ?? null,
    input.preferred_pct ?? null,
    input.common_pct ?? null,
    confidence,
    JSON.stringify({ holders_count: input.holders.length, notes: input.notes ?? null }),
    input.notes ?? null,
  ).run();

  let holdersWritten = 0;
  for (const h of input.holders) {
    if (!h.holder_name_raw || h.holder_name_raw.trim().length < 1) continue;
    const norm = normalizeHolderName(h.holder_name_raw);
    const holderEntityId = await resolveHolderEntity(env, h);
    try {
      await env.DB.prepare(
        `INSERT INTO cap_table_holders (
           id, snapshot_id, holder_entity_id, holder_name_raw, holder_name_normalized,
           holder_class, security_type, shares, pct_ownership, original_investment_usd,
           round_acquired, liquidation_preference_x, participating, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), snapshotId, holderEntityId, h.holder_name_raw, norm,
        h.holder_class ?? "unknown", h.security_type ?? null,
        h.shares ?? null, h.pct_ownership ?? null,
        h.original_investment_usd ?? null, h.round_acquired ?? null,
        h.liquidation_preference_x ?? null,
        h.participating == null ? null : (h.participating ? 1 : 0),
        h.notes ?? null,
      ).run();
      holdersWritten++;
    } catch (e) {
      console.warn("cap_table_holders insert failed", (e as Error).message);
      continue;
    }
    // Per-holder pivot fact on the holder entity.
    if (holderEntityId) {
      await insertFact(env, {
        entity_id: holderEntityId,
        predicate: "investor.holding_in_company",
        value_text: input.company_name_raw,
        value_entity_id: companyId,
        value_json: {
          snapshot_id: snapshotId, as_of: input.as_of, company_entity_id: companyId,
          security_type: h.security_type ?? null, shares: h.shares ?? null,
          pct_ownership: h.pct_ownership ?? null, round_acquired: h.round_acquired ?? null,
          original_investment_usd: h.original_investment_usd ?? null,
          source_kind: input.source_kind,
        },
        source_kind: "scrape", source: SOURCE_TAG, evidence_url: input.source_url,
        confidence,
      });
    }
  }

  // Company-side derived facts (one per signal). The summary rebuild
  // enqueue inside insertFact picks these up automatically.
  const factCtx = {
    entity_id: companyId, source_kind: "scrape" as const, source: SOURCE_TAG,
    evidence_url: input.source_url, confidence,
  };
  await insertFact(env, {
    ...factCtx, predicate: "cap_table.snapshot",
    value_text: input.source_kind, value_entity_id: snapshotId,
    value_json: {
      snapshot_id: snapshotId, as_of: input.as_of, source_kind: input.source_kind,
      post_money_usd: input.post_money_usd ?? null,
      fully_diluted_shares: input.fully_diluted_shares ?? null,
      option_pool_pct: input.option_pool_pct ?? null,
      holders_count: input.holders.length,
    },
    observed_at: input.as_of + "T00:00:00.000Z",
  });
  if (input.post_money_usd != null) {
    await insertFact(env, { ...factCtx, predicate: "cap_table.post_money_usd", value_number: input.post_money_usd });
  }
  if (input.fully_diluted_shares != null) {
    await insertFact(env, { ...factCtx, predicate: "cap_table.fully_diluted_shares", value_number: input.fully_diluted_shares });
  }
  if (input.option_pool_pct != null) {
    await insertFact(env, { ...factCtx, predicate: "cap_table.option_pool_pct", value_number: input.option_pool_pct });
  }

  return { snapshot_id: snapshotId, company_entity_id: companyId, holders_written: holdersWritten, skipped: false };
}
