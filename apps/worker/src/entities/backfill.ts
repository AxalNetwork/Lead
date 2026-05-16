// Idempotent backfill: walk every legacy table in batches of 200 and
// dual-write into the unified model. Safe to re-run — each row's
// (legacy_table, legacy_id) → entity_id mapping is preserved in
// entity_legacy_map, so the second pass just refreshes facts.

import type { Env } from "../types";
import {
  syncFirmToEntity, syncLeadToEntity, syncCompanyToEntity,
  syncAccountToEntity, syncBuyerToEntity,
} from "./dualwrite";

export interface BackfillProgress {
  table: string;
  scanned: number;
  synced: number;
  next_offset: number | null;
}

const BATCH = 200;

export async function backfillFirms(env: Env, offset = 0, limit = BATCH): Promise<BackfillProgress> {
  const r = await env.DB.prepare(
    `SELECT id, name, legal_name, website, domain, hq_country_iso2, hq_region, hq_city,
            check_size_min_usd, check_size_max_usd, check_size_typical_usd, thesis,
            linkedin_url, crunchbase_url, twitter_handle, contact_email,
            sectors_json, stages_json, geo_focus_json, kind
       FROM firms ORDER BY id LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let synced = 0;
  for (const row of slice) {
    const id = await syncFirmToEntity(env, row as never, "backfill");
    if (id) synced += 1;
  }
  return { table: "firms", scanned: slice.length, synced, next_offset: hasMore ? offset + limit : null };
}

export async function backfillLeads(env: Env, offset = 0, limit = BATCH): Promise<BackfillProgress> {
  const r = await env.DB.prepare(
    `SELECT id, name, email, phone, org, title, linkedin_url, twitter_url, github_url, personal_url,
            country_iso2, region, city, category, investor_kind,
            check_size_min_usd, check_size_max_usd, check_size_typical_usd,
            sector_focus_json, stage_focus_json, geo_focus_json, tags_json, thesis, bio
       FROM leads ORDER BY created_at LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let synced = 0;
  for (const row of slice) {
    const id = await syncLeadToEntity(env, row as never, "backfill");
    if (id) synced += 1;
  }
  return { table: "leads", scanned: slice.length, synced, next_offset: hasMore ? offset + limit : null };
}

export async function backfillCompanies(env: Env, offset = 0, limit = BATCH): Promise<BackfillProgress> {
  const r = await env.DB.prepare(
    `SELECT id, name, legal_name, website, domain, hq_country_iso2, hq_region, hq_city,
            stage, industries_json, unicorn, linkedin_url, crunchbase_url,
            twitter_handle, github_org
       FROM companies ORDER BY id LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let synced = 0;
  for (const row of slice) {
    const id = await syncCompanyToEntity(env, row as never, "backfill");
    if (id) synced += 1;
  }
  return { table: "companies", scanned: slice.length, synced, next_offset: hasMore ? offset + limit : null };
}

export async function backfillAccounts(env: Env, offset = 0, limit = BATCH): Promise<BackfillProgress> {
  const r = await env.DB.prepare(
    `SELECT id, name, legal_name, website, domain, industry, industries_json,
            hq_country_iso2, hq_region, hq_city, funding_stage,
            linkedin_url, twitter_handle, github_org, crunchbase_url,
            fit_score, intent_score
       FROM accounts ORDER BY created_at LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let synced = 0;
  for (const row of slice) {
    const id = await syncAccountToEntity(env, row as never, "backfill");
    if (id) synced += 1;
  }
  return { table: "accounts", scanned: slice.length, synced, next_offset: hasMore ? offset + limit : null };
}

export async function backfillBuyers(env: Env, offset = 0, limit = BATCH): Promise<BackfillProgress> {
  const r = await env.DB.prepare(
    `SELECT id, account_id, name, email, title, seniority, department, role_slug,
            linkedin_url, twitter_url, phone, is_decision_maker
       FROM buyers ORDER BY created_at LIMIT ? OFFSET ?`,
  ).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let synced = 0;
  for (const row of slice) {
    const id = await syncBuyerToEntity(env, row as never, "backfill");
    if (id) synced += 1;
  }
  return { table: "buyers", scanned: slice.length, synced, next_offset: hasMore ? offset + limit : null };
}

export async function backfillAll(env: Env, opts?: { batches?: number }): Promise<BackfillProgress[]> {
  const batches = Math.max(1, Math.min(opts?.batches ?? 1, 50));
  const out: BackfillProgress[] = [];
  for (const fn of [backfillFirms, backfillCompanies, backfillAccounts, backfillBuyers, backfillLeads]) {
    let offset = 0;
    for (let i = 0; i < batches; i++) {
      const p = await fn(env, offset);
      out.push(p);
      if (!p.next_offset) break;
      offset = p.next_offset;
    }
  }
  return out;
}
