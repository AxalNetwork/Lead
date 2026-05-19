// Task #5: Cap-Table API routes.
//
//   GET  /api/companies/:id/cap-table                — latest snapshot per source
//   GET  /api/companies/:id/cap-table/history        — all snapshots ordered by as_of
//   GET  /api/companies/:id/cap-table/dilution       — dilution waterfall
//   POST /api/companies/:id/cap-table/rebuild        — admin: re-sweep Form D + press
//
// All routes mount under /api/* (accessGuard) in apps/worker/src/index.ts.

import { Hono } from "hono";
import type { Env } from "../types";
import {
  buildDilutionWaterfall, mergeDealEventsIntoTimeline, projectTrajectory,
  sweepFormDInferenceForCompany, sweepPressInferenceForCompany,
  sweepS1InferenceForCompany, inferCapTableFromDeCoi, inferCapTableFromSecondaryListing,
  inferCapTableFromDelawareSosMetadata,
  type SnapshotForDilution, type DealEventForDilution,
} from "../services/capTable";
import type { CapTableSourceKind, HolderClass, SecurityType } from "../services/capTable/types";

type Vars = { email: string; is_admin: boolean };

export const capTableRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface SnapshotRow {
  id: string;
  company_entity_id: string;
  company_name_raw: string;
  as_of: string;
  source_kind: string;
  source_url: string;
  source_accession_no: string | null;
  fully_diluted_shares: number | null;
  post_money_usd: number | null;
  pre_money_usd: number | null;
  option_pool_pct: number | null;
  preferred_pct: number | null;
  common_pct: number | null;
  confidence: number;
  notes: string | null;
  created_at: string;
}

interface HolderRow {
  id: string;
  snapshot_id: string;
  holder_entity_id: string | null;
  holder_name_raw: string;
  holder_name_normalized: string | null;
  holder_class: string;
  security_type: string | null;
  shares: number | null;
  pct_ownership: number | null;
  original_investment_usd: number | null;
  round_acquired: string | null;
  liquidation_preference_x: number | null;
  participating: number | null;
}

async function resolveEntityIdFromCompanyParam(
  env: Env, idParam: string,
): Promise<string | null> {
  // The :id param accepts either a u_entities.id (TEXT uuid) or a
  // numeric companies.id (legacy). When numeric, hop through the
  // existing entity-resolve facts.
  if (/^[0-9]+$/.test(idParam)) {
    const c = await env.DB.prepare(
      `SELECT name FROM companies WHERE id = ?`,
    ).bind(Number(idParam)).first<{ name: string }>();
    if (!c) return null;
    // Look up via normalized name (mirrors deals route convention).
    const { normalizeCompanyName } = await import("../services/deals/dedupe");
    const norm = normalizeCompanyName(c.name);
    if (!norm) return null;
    const r = await env.DB.prepare(
      `SELECT entity_id FROM facts WHERE predicate='company.name_normalized' AND value_text=? AND is_current=1 LIMIT 1`,
    ).bind(norm).first<{ entity_id: string }>();
    return r?.entity_id ?? null;
  }
  return idParam;
}

async function loadSnapshotsForCompany(env: Env, entityId: string): Promise<SnapshotRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, company_entity_id, company_name_raw, as_of, source_kind, source_url,
            source_accession_no, fully_diluted_shares, post_money_usd, pre_money_usd,
            option_pool_pct, preferred_pct, common_pct, confidence, notes, created_at
       FROM cap_table_snapshots
      WHERE company_entity_id = ?
      ORDER BY as_of ASC, confidence DESC`,
  ).bind(entityId).all<SnapshotRow>();
  return r.results ?? [];
}

async function loadHoldersForSnapshots(env: Env, snapshotIds: string[]): Promise<Map<string, HolderRow[]>> {
  if (!snapshotIds.length) return new Map();
  const placeholders = snapshotIds.map(() => "?").join(",");
  const r = await env.DB.prepare(
    `SELECT id, snapshot_id, holder_entity_id, holder_name_raw, holder_name_normalized,
            holder_class, security_type, shares, pct_ownership, original_investment_usd,
            round_acquired, liquidation_preference_x, participating
       FROM cap_table_holders
      WHERE snapshot_id IN (${placeholders})
      ORDER BY pct_ownership DESC NULLS LAST, shares DESC NULLS LAST`,
  ).bind(...snapshotIds).all<HolderRow>();
  const grouped = new Map<string, HolderRow[]>();
  for (const h of (r.results ?? [])) {
    if (!grouped.has(h.snapshot_id)) grouped.set(h.snapshot_id, []);
    grouped.get(h.snapshot_id)!.push(h);
  }
  return grouped;
}

function serializeSnapshot(s: SnapshotRow, holders: HolderRow[]) {
  return {
    snapshot_id: s.id,
    company_entity_id: s.company_entity_id,
    company_name_raw: s.company_name_raw,
    as_of: s.as_of,
    source_kind: s.source_kind,
    source_url: s.source_url,
    source_accession_no: s.source_accession_no,
    fully_diluted_shares: s.fully_diluted_shares,
    post_money_usd: s.post_money_usd,
    pre_money_usd: s.pre_money_usd,
    option_pool_pct: s.option_pool_pct,
    preferred_pct: s.preferred_pct,
    common_pct: s.common_pct,
    confidence: s.confidence,
    notes: s.notes,
    created_at: s.created_at,
    holders: holders.map((h) => ({
      holder_name: h.holder_name_raw,
      holder_entity_id: h.holder_entity_id,
      holder_class: h.holder_class,
      security_type: h.security_type,
      shares: h.shares,
      pct_ownership: h.pct_ownership,
      original_investment_usd: h.original_investment_usd,
      round_acquired: h.round_acquired,
      liquidation_preference_x: h.liquidation_preference_x,
      participating: h.participating == null ? null : !!h.participating,
      // Per-holder evidence: row-level when available (future:
      // section anchors / table-cell URLs), else inherit the
      // snapshot's source URL so every holder row is independently
      // verifiable against the public artifact.
      evidence_url: s.source_url,
      evidence_source_kind: s.source_kind,
      evidence_accession_no: s.source_accession_no,
    })),
  };
}

// ---------------------------------------------------------- LATEST
capTableRoute.get("/:id/cap-table", async (c) => {
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const all = await loadSnapshotsForCompany(c.env, entityId);
  if (!all.length) return c.json({ entity_id: entityId, snapshots: [], latest_by_source: {}, best: null });
  // Latest per source kind.
  const latestBySource = new Map<string, SnapshotRow>();
  for (const s of all) {
    const prior = latestBySource.get(s.source_kind);
    if (!prior || s.as_of > prior.as_of) latestBySource.set(s.source_kind, s);
  }
  // "Best" snapshot: prefer highest source-confidence tier with most
  // holders, breaking ties by recency.
  const tier: Record<string, number> = {
    s1_filing: 5, delaware_coi: 4, form_d_inference: 3,
    secondary_listing: 2, press_inference: 1,
  };
  const candidates = Array.from(latestBySource.values());
  // A snapshot tagged metadata_only=true (e.g. DE-SOS metadata path) is
  // structurally empty (no holders, no shares, no post-money). Demote
  // these below ANY snapshot carrying real holder rows so a richer
  // form_d_inference or press_inference doesn't get hidden behind a
  // bare COI metadata entry.
  const isMetadataOnly = (s: SnapshotRow): boolean =>
    !!(s.notes && /metadata_only\s*=\s*true/i.test(s.notes));
  const holdersCountByIdRaw = await c.env.DB.prepare(
    `SELECT snapshot_id, COUNT(*) AS n FROM cap_table_holders WHERE snapshot_id IN (${candidates.map(() => "?").join(",") || "''"}) GROUP BY snapshot_id`,
  ).bind(...candidates.map((s) => s.id)).all<{ snapshot_id: string; n: number }>().catch(() => ({ results: [] as { snapshot_id: string; n: number }[] }));
  const holdersCount = new Map<string, number>();
  for (const r of (holdersCountByIdRaw.results ?? [])) holdersCount.set(r.snapshot_id, r.n);
  candidates.sort((a, b) => {
    const aMeta = isMetadataOnly(a) || (holdersCount.get(a.id) ?? 0) === 0;
    const bMeta = isMetadataOnly(b) || (holdersCount.get(b.id) ?? 0) === 0;
    // Snapshots with real holders always beat metadata-only/empty ones.
    if (aMeta !== bMeta) return aMeta ? 1 : -1;
    return (tier[b.source_kind] ?? 0) - (tier[a.source_kind] ?? 0)
      || b.confidence - a.confidence
      || b.as_of.localeCompare(a.as_of);
  });
  const best = candidates[0];
  const ids = candidates.map((s) => s.id);
  const holders = await loadHoldersForSnapshots(c.env, ids);
  return c.json({
    entity_id: entityId,
    best: best ? serializeSnapshot(best, holders.get(best.id) ?? []) : null,
    latest_by_source: Object.fromEntries(
      candidates.map((s) => [s.source_kind, serializeSnapshot(s, holders.get(s.id) ?? [])]),
    ),
    snapshot_count: all.length,
  });
});

// ---------------------------------------------------------- HISTORY
capTableRoute.get("/:id/cap-table/history", async (c) => {
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const all = await loadSnapshotsForCompany(c.env, entityId);
  const holders = await loadHoldersForSnapshots(c.env, all.map((s) => s.id));
  return c.json({
    entity_id: entityId,
    count: all.length,
    snapshots: all.map((s) => serializeSnapshot(s, holders.get(s.id) ?? [])),
  });
});

// ---------------------------------------------------------- DILUTION
capTableRoute.get("/:id/cap-table/dilution", async (c) => {
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const all = await loadSnapshotsForCompany(c.env, entityId);
  const holders = await loadHoldersForSnapshots(c.env, all.map((s) => s.id));
  const input: SnapshotForDilution[] = all.map((s) => ({
    id: s.id, as_of: s.as_of,
    source_kind: s.source_kind as CapTableSourceKind,
    fully_diluted_shares: s.fully_diluted_shares,
    post_money_usd: s.post_money_usd,
    option_pool_pct: s.option_pool_pct,
    preferred_pct: s.preferred_pct,
    common_pct: s.common_pct,
    confidence: s.confidence,
    holders: (holders.get(s.id) ?? []).map((h) => ({
      holder_name_normalized: h.holder_name_normalized,
      holder_name_raw: h.holder_name_raw,
      holder_entity_id: h.holder_entity_id,
      holder_class: h.holder_class as HolderClass,
      security_type: h.security_type as SecurityType | null,
      shares: h.shares,
      pct_ownership: h.pct_ownership,
      round_acquired: h.round_acquired,
    })),
  }));
  // Merge funding-round deal_events into the timeline so rounds with
  // no parsed snapshot still appear as a dilution step. Sector
  // medians fill missing post-money.
  const deals = await c.env.DB.prepare(
    `SELECT id, COALESCE(announcement_date, closing_date) AS as_of,
            round_name, amount_usd, valuation_usd, sector_tags_json
       FROM deal_events
      WHERE company_entity_id = ? AND event_type = 'funding_round'
        AND (announcement_date IS NOT NULL OR closing_date IS NOT NULL)
      ORDER BY as_of ASC`,
  ).bind(entityId).all<{ id: string; as_of: string; round_name: string | null; amount_usd: number | null; valuation_usd: number | null; sector_tags_json: string | null }>();
  const dealRows: DealEventForDilution[] = (deals.results ?? []).map((d) => ({
    id: d.id, as_of: d.as_of, round_name: d.round_name,
    amount_usd: d.amount_usd, valuation_usd: d.valuation_usd,
    sector_tag: d.sector_tags_json ? (() => { try { const a = JSON.parse(d.sector_tags_json!); return Array.isArray(a) && a.length ? String(a[0]) : null; } catch { return null; } })() : null,
  }));
  // Sector median post-money (cheap fallback).
  const sectorRow = dealRows.find((d) => d.sector_tag);
  let medianPost: number | null = null;
  if (sectorRow?.sector_tag) {
    const r = await c.env.DB.prepare(
      `SELECT valuation_usd FROM deal_events
        WHERE valuation_usd IS NOT NULL AND event_type='funding_round'
          AND sector_tags_json LIKE ?
        ORDER BY valuation_usd ASC LIMIT 200`,
    ).bind(`%${sectorRow.sector_tag}%`).all<{ valuation_usd: number }>();
    const vals = (r.results ?? []).map((x) => x.valuation_usd).filter((v) => v > 0);
    if (vals.length >= 5) medianPost = vals[Math.floor(vals.length / 2)];
  }
  const merged = mergeDealEventsIntoTimeline(input, dealRows, medianPost);
  if (merged.length < 2) {
    return c.json({
      entity_id: entityId, steps: [], projection: null,
      sector_median_post_money_usd: medianPost,
      deal_events_merged: dealRows.length,
      reason: "need_two_timeline_points",
    });
  }
  const steps = buildDilutionWaterfall(merged);
  const projection = projectTrajectory(steps);
  return c.json({
    entity_id: entityId,
    steps,
    projection,
    sector_median_post_money_usd: medianPost,
    deal_events_merged: dealRows.length,
  });
});

// ---------------------------------------------------------- REBUILD
// Admin-only. Sweeps every ingestion path we can drive without a
// human-supplied URL (Form D, press wires, archived S-1s) and
// optionally accepts a body of `coi_urls[]` / `secondary_urls[]` so
// operators can backfill Delaware COIs and secondary listings on
// demand without waiting for the upstream crawler.
capTableRoute.post("/:id/cap-table/rebuild", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "forbidden" }, 403);
  const entityId = await resolveEntityIdFromCompanyParam(c.env, c.req.param("id"));
  if (!entityId) return c.json({ error: "company_not_resolved" }, 404);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const coiUrls = Array.isArray((body as { coi_urls?: unknown }).coi_urls)
    ? ((body as { coi_urls: unknown[] }).coi_urls.filter((x) => typeof x === "string") as string[])
    : [];
  const secUrls = Array.isArray((body as { secondary_urls?: unknown }).secondary_urls)
    ? ((body as { secondary_urls: unknown[] }).secondary_urls.filter((x) => typeof x === "string") as string[])
    : [];
  const sosMeta = (body as { delaware_sos?: unknown }).delaware_sos as
    | { file_number: string; formation_date: string; entity_status?: string; registered_agent?: string; source_url?: string }
    | undefined;
  const company = await c.env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(entityId).first<{ display_name: string }>();
  const name = company?.display_name ?? "Unknown company";

  const fd = await sweepFormDInferenceForCompany(c.env, entityId);
  const press = await sweepPressInferenceForCompany(c.env, entityId);
  const s1 = await sweepS1InferenceForCompany(c.env, entityId);
  const coi: Array<{ url: string; snapshot_id: string | null; holders: number; skipped: boolean; reason?: string }> = [];
  for (const url of coiUrls.slice(0, 10)) {
    try {
      const r = await inferCapTableFromDeCoi(c.env, { company_entity_id: entityId, company_name_raw: name, source_url: url });
      coi.push({ url, snapshot_id: r.snapshot_id, holders: r.holders_written, skipped: r.skipped, reason: r.reason });
    } catch (e) {
      coi.push({ url, snapshot_id: null, holders: 0, skipped: true, reason: (e as Error).message });
    }
  }
  const sec: Array<{ url: string; snapshot_id: string | null; holders: number; skipped: boolean; reason?: string }> = [];
  for (const url of secUrls.slice(0, 10)) {
    try {
      const r = await inferCapTableFromSecondaryListing(c.env, { company_entity_id: entityId, company_name_raw: name, listing_url: url });
      sec.push({ url, snapshot_id: r.snapshot_id, holders: r.holders_written, skipped: r.skipped, reason: r.reason });
    } catch (e) {
      sec.push({ url, snapshot_id: null, holders: 0, skipped: true, reason: (e as Error).message });
    }
  }
  let deSos: { snapshot_id: string | null; skipped: boolean; reason?: string } | null = null;
  if (sosMeta?.file_number && sosMeta?.formation_date) {
    try {
      const r = await inferCapTableFromDelawareSosMetadata(c.env, {
        company_entity_id: entityId, company_name_raw: name,
        file_number: sosMeta.file_number, formation_date: sosMeta.formation_date,
        entity_status: sosMeta.entity_status ?? null,
        registered_agent: sosMeta.registered_agent ?? null,
        source_url: sosMeta.source_url ?? null,
      });
      deSos = { snapshot_id: r.snapshot_id, skipped: r.skipped, reason: r.reason };
    } catch (e) {
      deSos = { snapshot_id: null, skipped: true, reason: (e as Error).message };
    }
  }
  return c.json({ entity_id: entityId, form_d: fd, press, s1, delaware_coi: coi, secondary_listing: sec, delaware_sos_metadata: deSos });
});
