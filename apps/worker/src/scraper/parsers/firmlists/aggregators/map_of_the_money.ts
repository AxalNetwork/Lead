import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, importKey, type AggregatorHints } from "./_base";
import { countryFromLatLng } from "./_geo";

/**
 * Map of the Money (mapofthemoney.com) — globally-distributed VC map.
 *
 * The site renders an interactive map seeded by a single XHR that
 * returns a GeoJSON-style FeatureCollection (or a flat JSON array) of
 * investors. We:
 *   1. Browser-render the landing page (forces the XHR to run).
 *   2. Look for an embedded JSON payload (`__NEXT_DATA__`, an inline
 *      `<script>window.__MOTM__ = …</script>` block, or a fetched
 *      `/data/investors.json` candidate).
 *   3. For each record we reverse-geocode lat/lng → ISO2 country via
 *      the static bbox lookup in `_geo.ts` and emit a `country:{ISO2}`
 *      tag on the firm.
 *
 * Records without coordinates are still emitted (just without a
 * country tag) so the importer always returns useful rows.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }
  const html = fetched.html;
  const errors: string[] = [];
  const records = extractInvestorPayload(html);

  // Best-effort secondary fetch: many of these sites expose a stable
  // `/data/*.json` endpoint that the page hydrates from. If we find
  // zero embedded records, try a couple of well-known paths.
  if (!records.length) {
    for (const path of ["/data/investors.json", "/api/investors", "/investors.json"]) {
      try {
        const u = new URL(path, url).toString();
        await awaitHostSlot(env, u);
        const r = await fetch(u, { headers: { accept: "application/json" } });
        if (!r.ok) continue;
        const json = (await r.json()) as unknown;
        const more = flattenInvestorJson(json);
        if (more.length) { records.push(...more); break; }
      } catch { /* swallow */ }
    }
  }

  if (!records.length) {
    errors.push("no_investor_payload_found");
    return { firms: [], totalSeen: 0, errors };
  }

  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];

  for (const r of records) {
    const name = (r.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const row: Record<string, unknown> = { name };
    if (r.website) row.website = r.website;
    if (r.thesis) row.thesis = r.thesis;
    if (r.city) row.city = r.city;

    const cand = rowToCandidate(row, url);
    if (!cand) continue;

    const iso2 = r.lat != null && r.lng != null ? countryFromLatLng(r.lat, r.lng) : null;
    const tagSet = new Set<string>(Array.isArray((cand.candidate as { tags?: string[] }).tags) ? (cand.candidate as { tags?: string[] }).tags! : []);
    if (iso2) {
      if (!cand.candidate.hq_country_iso2) cand.candidate.hq_country_iso2 = iso2;
      tagSet.add(`country:${iso2}`);
    }
    if (tagSet.size) (cand.candidate as { tags?: string[] }).tags = [...tagSet];
    (cand.candidate as { import_key?: string }).import_key = importKey("motm", name);
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, hints);
  return { firms, totalSeen: records.length, errors: errors.length ? errors : undefined };
}

interface RawInvestor {
  name: string;
  website?: string;
  thesis?: string;
  city?: string;
  lat?: number;
  lng?: number;
}

function extractInvestorPayload(html: string): RawInvestor[] {
  const out: RawInvestor[] = [];

  // Pattern 1: Next.js __NEXT_DATA__ blob.
  const next = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) {
    try { out.push(...flattenInvestorJson(JSON.parse(next[1]))); } catch { /* fall through */ }
  }

  // Pattern 2: window.__MOTM__ = { … } or window.MOTM_DATA = [ … ].
  const inlineRe = /window\.(?:__MOTM__|MOTM_DATA|__INVESTORS__|INVESTORS)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(html)) !== null) {
    try { out.push(...flattenInvestorJson(JSON.parse(m[1]))); } catch { /* skip */ }
  }

  // Pattern 3: GeoJSON FeatureCollection inlined in any script tag.
  const fcRe = /(\{\s*"type"\s*:\s*"FeatureCollection"[\s\S]*?\})\s*[<;,]/g;
  let fm: RegExpExecArray | null;
  while ((fm = fcRe.exec(html)) !== null) {
    try { out.push(...flattenInvestorJson(JSON.parse(fm[1]))); } catch { /* skip */ }
  }

  return out;
}

/**
 * Walks an arbitrary JSON blob and pulls every shape that looks like
 * an investor record. Supports:
 *   - GeoJSON FeatureCollection.features[].properties + .geometry.coordinates
 *   - Flat arrays of {name, website, lat, lng}
 *   - Nested arrays under any property whose first element looks like
 *     an investor (has both a name and lat/lng).
 */
function flattenInvestorJson(blob: unknown): RawInvestor[] {
  const out: RawInvestor[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    // GeoJSON Feature?
    const geom = o.geometry as Record<string, unknown> | undefined;
    const props = (o.properties as Record<string, unknown> | undefined) ?? o;
    const name = pickStr(props, ["name", "title", "investor", "firm", "fund"]);
    const lat = pickCoord(o, props, geom, "lat");
    const lng = pickCoord(o, props, geom, "lng");
    if (name) {
      out.push({
        name,
        website: pickStr(props, ["website", "url", "site", "homepage"]) ?? undefined,
        thesis: pickStr(props, ["description", "thesis", "summary", "about"]) ?? undefined,
        city: pickStr(props, ["city", "location", "hq", "town"]) ?? undefined,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
      });
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(blob);
  return out;
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickCoord(
  o: Record<string, unknown>,
  props: Record<string, unknown>,
  geom: Record<string, unknown> | undefined,
  which: "lat" | "lng",
): number | null {
  const keys = which === "lat" ? ["lat", "latitude", "Lat", "LAT"] : ["lng", "lon", "longitude", "Lng", "Lon", "LNG"];
  for (const k of keys) {
    const v = props[k] ?? o[k];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  // GeoJSON coordinates are [lng, lat].
  if (geom && Array.isArray(geom.coordinates)) {
    const c = geom.coordinates as unknown[];
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (which === "lat" && Number.isFinite(lat)) return lat;
    if (which === "lng" && Number.isFinite(lng)) return lng;
  }
  return null;
}
