// Task #18: Term-Sheet Intelligence routes.
//
//   GET /api/companies/:id/preferred-stack       — every current series + percentile pills
//   GET /api/investors/:id/term-aggressiveness   — weighted score + per-term breakdown
//   GET /api/term-benchmarks?stage=&sector=&year= — published distributions
//
// All routes sit behind the global accessGuard (mounted in index.ts).

import { Hono } from "hono";
import type { Env } from "../types";
import { getCurrentPreferredStack, upsertPreferredSeries } from "../services/termSheets/persist";
import { findBenchmark, MIN_BUCKET_SAMPLE } from "../services/termSheets/benchmarks";
import { computeInvestorAggressiveness } from "../services/termSheets/aggressiveness";
import { fetchDelawareCoi } from "../services/termSheets/delawareCoi";
import { extractLeakCandidates } from "../services/termSheets/leakHarvester";

export const companiesPreferredStackRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();
export const investorsTermAggressivenessRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();
export const termBenchmarksRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();
export const termLeaksRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

function isAggressive(row: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const lp = row.liquidation_pref_x as number | null;
  const part = row.participating as number | null;
  const cap = row.participating_cap_x as number | null;
  const ad = row.anti_dilution as string | null;
  if (lp != null && lp > 1) flags.push(`gt_1x_lp`);
  if (part === 1 && cap == null) flags.push("uncapped_participating");
  if (ad === "full_ratchet") flags.push("full_ratchet");
  return flags;
}

companiesPreferredStackRoute.get("/:id/preferred-stack", async (c) => {
  const id = c.req.param("id");
  const series = await getCurrentPreferredStack(c.env, id);
  const out = [];
  for (const s of series) {
    const stage = (s.stage as string) ?? null;
    const sector = (s.sector as string) ?? null;
    const closing = (s.closing_date as string) ?? null;
    const year = closing ? Number(closing.slice(0, 4)) : null;
    const bench = stage && year ? await findBenchmark(c.env, stage, sector, year) : null;
    const percentiles: Record<string, number | null> = {};
    if (bench) {
      const lp = s.liquidation_pref_x as number | null;
      if (lp != null && bench.median_lp_x != null) {
        percentiles.lp_x_vs_median = Number((lp / bench.median_lp_x).toFixed(2));
      }
      percentiles.pct_lp_gt_1x_in_bucket = bench.pct_lp_gt_1x;
      percentiles.pct_participating_in_bucket = bench.pct_participating;
      percentiles.pct_full_ratchet_in_bucket = bench.pct_full_ratchet;
    }
    let payload: unknown = null;
    try { payload = s.payload_json ? JSON.parse(s.payload_json as string) : null; } catch { payload = null; }
    out.push({
      ...s,
      payload,
      bucket: stage && year ? { stage, sector: sector ?? "unknown", year, sample_size: bench?.sample_size ?? 0, low_sample: (bench?.sample_size ?? 0) < MIN_BUCKET_SAMPLE } : null,
      percentiles,
      aggressive_flags: isAggressive(s),
    });
  }
  return c.json({ company_entity_id: id, series: out });
});

investorsTermAggressivenessRoute.get("/:id/term-aggressiveness", async (c) => {
  const id = c.req.param("id");
  const result = await computeInvestorAggressiveness(c.env, id);
  return c.json(result);
});

// Admin-only: trigger a Delaware COI fetch for a specific company. The
// underlying `fetchDelawareCoi` returns a documented `unconfigured`
// result when DELAWARE_COI_API_{URL,KEY} are absent (PACER-honesty
// pattern from Task #14) — operators see that status explicitly rather
// than a silent no-op.
companiesPreferredStackRoute.post("/:id/preferred-stack/fetch-delaware", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ company_name?: string }>().catch(() => ({} as { company_name?: string }));
  const companyName = (body.company_name ?? "").trim();
  if (!companyName) return c.json({ error: "company_name_required" }, 400);
  const result = await fetchDelawareCoi(c.env, companyName);
  if (result.status === "extracted" && result.extraction) {
    let persisted = 0;
    for (const series of result.extraction.series) {
      try {
        await upsertPreferredSeries(c.env, {
          company_entity_id: id,
          series,
          source: "delaware_coi",
          source_kind: "import",
          source_url: result.source_url ?? null,
          source_accession_no: null,
        });
        persisted++;
      } catch (e) { console.warn("delaware_coi upsert failed", (e as Error).message); }
    }
    return c.json({ status: "extracted", persisted, source_url: result.source_url ?? null });
  }
  return c.json({ status: result.status, reason: result.reason });
});

// Admin-only: ingest an operator-pasted press / Twitter leak excerpt.
// Runs the same parser against the excerpt and persists candidate
// series with source='press_leak' and confidence clamped to ≤0.5 (so
// they're filterable out of `term_benchmarks` inputs until promoted).
termLeaksRoute.post("/", async (c) => {
  if (!c.var.is_admin) return c.json({ error: "forbidden" }, 403);
  type LeakBody = { company_entity_id?: string; company_name?: string; source_url?: string; excerpt?: string };
  const body = await c.req.json<LeakBody>().catch(() => ({} as LeakBody));
  const id = (body.company_entity_id ?? "").trim();
  const name = (body.company_name ?? "").trim();
  const url = (body.source_url ?? "").trim();
  const excerpt = (body.excerpt ?? "").trim();
  if (!id || !name || !url || !excerpt) {
    return c.json({ error: "company_entity_id, company_name, source_url, excerpt required" }, 400);
  }
  const cand = extractLeakCandidates({ companyName: name, sourceUrl: url, excerpt });
  let persisted = 0;
  for (const series of cand.series) {
    try {
      await upsertPreferredSeries(c.env, {
        company_entity_id: id,
        series,
        source: "press_leak",
        source_kind: "scrape",
        source_url: url,
        source_accession_no: null,
      });
      persisted++;
    } catch (e) { console.warn("press_leak upsert failed", (e as Error).message); }
  }
  console.log("term.leak.ingested", JSON.stringify({ company_entity_id: id, source_url: url, persisted }));
  return c.json({ status: "ok", parsed: cand.series.length, persisted });
});

termBenchmarksRoute.get("/", async (c) => {
  const stage = c.req.query("stage") || null;
  const sector = c.req.query("sector") || null;
  const year = c.req.query("year") ? Number(c.req.query("year")) : null;
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (stage) { where.push("stage = ?"); args.push(stage); }
  if (sector) { where.push("sector = ?"); args.push(sector); }
  if (year && Number.isFinite(year)) { where.push("year = ?"); args.push(year); }
  const sql = `SELECT * FROM term_benchmarks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY year DESC, stage, sector LIMIT 500`;
  const r = await c.env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  const benchmarks = (r.results ?? []).map((b) => ({ ...b, low_sample: (b.sample_size as number) < MIN_BUCKET_SAMPLE }));
  return c.json({ benchmarks, min_sample: MIN_BUCKET_SAMPLE });
});
