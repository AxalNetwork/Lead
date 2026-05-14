// Tagging service: maps freeform sector/location text on a lead to canonical
// taxonomy slugs, and writes them back via LeadsRepo so audit history is kept.

import type { Env } from "../types";
import type { Lead, LeadPatch } from "../db/leads.types";
import { LeadsRepo } from "../db/leads.repo";
import { resolveSectorSlug, resolveGeoSlug } from "./loader";

function pickSectorText(lead: Lead): string | null {
  const j = lead.sector_focus_json;
  if (j) {
    try {
      const arr = JSON.parse(j) as unknown;
      if (Array.isArray(arr) && arr.length) return String(arr[0] ?? "");
    } catch { /* fall through */ }
  }
  return lead.category ?? null;
}

function pickLocationText(lead: Lead): string | null {
  const parts = [lead.city, lead.region, lead.country_iso2].filter(Boolean) as string[];
  if (parts.length) return parts.join(", ");
  return null;
}

/**
 * Compute taxonomy slugs for a lead and persist any changes (with audit).
 * Returns the patch that was applied (or {} when nothing changed).
 */
export async function tagLead(env: Env, leadId: string, opts: { source?: string } = {}): Promise<LeadPatch> {
  const repo = new LeadsRepo(env.DB);
  const lead = await repo.getById(leadId);
  if (!lead) return {};

  const sectorSlug = resolveSectorSlug(pickSectorText(lead));
  const { slug: geoSlug, country_iso2 } = resolveGeoSlug(pickLocationText(lead));

  const patch: LeadPatch = {};
  if (sectorSlug && sectorSlug !== lead.sector_slug) patch.sector_slug = sectorSlug;
  if (geoSlug && geoSlug !== lead.geo_slug) patch.geo_slug = geoSlug;
  if (country_iso2 && !lead.country_iso2) patch.country_iso2 = country_iso2;

  if (Object.keys(patch).length === 0) return {};
  await repo.updateLead(leadId, patch, { source: opts.source ?? "tagger:auto", evidence_url: "tagger" });
  return patch;
}

/** Convenience for direct in-process tagging without a fresh DB read. */
export function deriveSlugs(lead: Pick<Lead, "category" | "sector_focus_json" | "city" | "region" | "country_iso2">) {
  const sectorSlug = resolveSectorSlug(((): string | null => {
    const j = lead.sector_focus_json;
    if (j) { try { const arr = JSON.parse(j); if (Array.isArray(arr) && arr.length) return String(arr[0]); } catch { /* */ } }
    return lead.category ?? null;
  })());
  const loc = [lead.city, lead.region, lead.country_iso2].filter(Boolean).join(", ") || null;
  const { slug: geoSlug, country_iso2 } = resolveGeoSlug(loc);
  return { sectorSlug, geoSlug, country_iso2 };
}
