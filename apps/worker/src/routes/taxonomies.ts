import { Hono } from "hono";
import type { Env } from "../types";
import { listSectors, listGeographies, resolveSectorSlug, resolveGeoSlug } from "../tax/loader";
import { ensureTaxonomySeeded } from "../tax/seed";

export const taxonomies = new Hono<{ Bindings: Env; Variables: { email: string } }>();

taxonomies.get("/sectors", async (c) => {
  await ensureTaxonomySeeded(c.env);
  // Read back from DB so any operator-managed alias edits flow through.
  const r = await c.env.DB.prepare(
    "SELECT slug, label, parent_slug, aliases_json, description FROM tax_sectors ORDER BY label",
  ).all<{ slug: string; label: string; parent_slug: string | null; aliases_json: string; description: string | null }>();
  const items = (r.results ?? []).map((s) => ({
    slug: s.slug,
    label: s.label,
    parent_slug: s.parent_slug,
    description: s.description,
    aliases: safeArr(s.aliases_json),
  }));
  // Fallback to JSON if DB is somehow empty (e.g. migration not yet applied).
  return c.json({ items: items.length ? items : listSectors() });
});

taxonomies.get("/geographies", async (c) => {
  await ensureTaxonomySeeded(c.env);
  const kind = c.req.query("kind");
  const sql = kind
    ? "SELECT slug, label, kind, country_iso2, parent_slug, aliases_json, lat, lng FROM tax_geographies WHERE kind = ? ORDER BY label"
    : "SELECT slug, label, kind, country_iso2, parent_slug, aliases_json, lat, lng FROM tax_geographies ORDER BY label";
  const r = kind
    ? await c.env.DB.prepare(sql).bind(kind).all<any>()
    : await c.env.DB.prepare(sql).all<any>();
  const items = (r.results ?? []).map((g: any) => ({
    slug: g.slug, label: g.label, kind: g.kind,
    country_iso2: g.country_iso2, parent_slug: g.parent_slug,
    lat: g.lat, lng: g.lng,
    aliases: safeArr(g.aliases_json),
  }));
  return c.json({ items: items.length ? items : listGeographies().filter((g) => !kind || g.kind === kind) });
});

// Sector × geography (country-grain) heatmap of live (non-merged, non-erased) leads.
taxonomies.get("/heatmap", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT
        COALESCE(sector_slug, '__unmapped__') AS sector,
        COALESCE(country_iso2, '__unmapped__') AS country,
        COUNT(*) AS n
       FROM leads
       WHERE (merged_into IS NULL OR merged_into = '')
         AND status != 'erased'
       GROUP BY sector, country
       ORDER BY n DESC
       LIMIT 5000`,
  ).all<{ sector: string; country: string; n: number }>();
  return c.json({ cells: r.results ?? [] });
});

// Resolve a freeform string to a slug. Useful for the dashboard previews.
taxonomies.get("/resolve", (c) => {
  const q = c.req.query("q") ?? "";
  return c.json({
    sector: resolveSectorSlug(q),
    geography: resolveGeoSlug(q),
  });
});

function safeArr(j: string | null | undefined): string[] {
  if (!j) return [];
  try { const a = JSON.parse(j); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
