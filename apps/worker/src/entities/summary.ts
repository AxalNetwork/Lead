// Rebuild `entity_summary` for one entity from its current facts +
// channels + tags + roles. Runs inside the queue consumer.

import type { Env } from "../types";

interface FactRow {
  predicate: string;
  value_text: string | null;
  value_number: number | null;
  value_json: string | null;
  value_entity_id: string | null;
  confidence: number;
  observed_at: string;
  source_kind: string;
}

interface TagRow { taxonomy: string; slug: string; weight: number }
interface RoleRow { role: string; is_primary: number; confidence: number }
interface ChannelRow { kind: string; canonical: string; display: string | null; is_primary: number; is_verified: number }

const SOURCE_PRIORITY: Record<string, number> = {
  manual: 5, enrichment: 4, import: 3, scrape: 2, ai: 1, inferred: 0,
};

function pickBestFact(rows: FactRow[]): FactRow | null {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    const sa = (a.confidence ?? 0) * 100 + (SOURCE_PRIORITY[a.source_kind] ?? 0) * 10 + Date.parse(a.observed_at) / 1e12;
    const sb = (b.confidence ?? 0) * 100 + (SOURCE_PRIORITY[b.source_kind] ?? 0) * 10 + Date.parse(b.observed_at) / 1e12;
    return sb - sa;
  })[0];
}

function txt(rows: FactRow[], predicate: string): string | null {
  const f = pickBestFact(rows.filter((r) => r.predicate === predicate));
  return f?.value_text ?? null;
}

function num(rows: FactRow[], predicate: string): number | null {
  const f = pickBestFact(rows.filter((r) => r.predicate === predicate));
  return f?.value_number ?? null;
}

export async function rebuildSummary(env: Env, entityId: string): Promise<boolean> {
  const ent = await env.DB.prepare(`SELECT * FROM u_entities WHERE id = ?`).bind(entityId).first<{
    id: string; kind: string; display_name: string | null; primary_domain: string | null;
    quality_score: number; status: string;
  }>();
  if (!ent) return false;
  if (ent.status === "merged" || ent.status === "soft_deleted") {
    await env.DB.prepare(`DELETE FROM entity_summary WHERE entity_id = ?`).bind(entityId).run();
    return true;
  }

  const [factsRes, tagsRes, rolesRes, channelsRes] = await Promise.all([
    env.DB.prepare(`SELECT predicate, value_text, value_number, value_json, value_entity_id, confidence, observed_at, source_kind FROM facts WHERE entity_id = ? AND is_current = 1`).bind(entityId).all<FactRow>(),
    env.DB.prepare(`SELECT taxonomy, slug, weight FROM entity_tags WHERE entity_id = ?`).bind(entityId).all<TagRow>(),
    env.DB.prepare(`SELECT role, is_primary, confidence FROM entity_roles WHERE entity_id = ?`).bind(entityId).all<RoleRow>(),
    env.DB.prepare(`SELECT kind, canonical, display, is_primary, is_verified FROM channels WHERE entity_id = ?`).bind(entityId).all<ChannelRow>(),
  ]);
  const facts = factsRes.results ?? [];
  const tags = tagsRes.results ?? [];
  const roles = rolesRes.results ?? [];
  const channels = channelsRes.results ?? [];

  const primaryRole = (roles.find((r) => r.is_primary === 1) ?? roles[0])?.role ?? null;
  const display = ent.display_name ?? txt(facts, "name") ?? txt(facts, "display_name");
  const country = txt(facts, "country_iso2");
  const region = txt(facts, "region");
  const city = txt(facts, "city");
  const sectors = tags.filter((t) => t.taxonomy === "sector").map((t) => t.slug);
  const stages = tags.filter((t) => t.taxonomy === "stage").map((t) => t.slug);
  const geos = tags.filter((t) => t.taxonomy === "geo").map((t) => t.slug);
  const checkMin = num(facts, "check_size_min_usd");
  const checkMax = num(facts, "check_size_max_usd");
  const fitMax = num(facts, "fit_max_score") ?? 0;
  const intent = num(facts, "intent_score") ?? 0;
  const unicornCount = Math.round(num(facts, "unicorn_count") ?? 0);

  const primaryEmailChan = channels.filter((c) => c.kind === "email").sort((a, b) => (b.is_primary - a.is_primary) || (b.is_verified - a.is_verified))[0];
  const primaryLinkedinChan = channels.filter((c) => c.kind === "linkedin")[0];

  const employerEntityId = (facts.find((f) => f.predicate === "employer" && f.value_entity_id) ?? null)?.value_entity_id ?? null;
  let employerDisplay: string | null = null;
  if (employerEntityId) {
    const r = await env.DB.prepare(`SELECT display_name FROM u_entities WHERE id = ?`).bind(employerEntityId).first<{ display_name: string | null }>();
    employerDisplay = r?.display_name ?? null;
  } else {
    employerDisplay = txt(facts, "primary_employer") ?? txt(facts, "org");
  }

  // Quality: coverage × confidence average × source diversity, scaled 0..100.
  const coverage = Math.min(1, facts.length / 12);
  const confAvg = facts.length ? facts.reduce((s, f) => s + (f.confidence ?? 0), 0) / facts.length : 0;
  const diversity = Math.min(1, new Set(facts.map((f) => f.source_kind)).size / 3);
  const quality = Math.round((coverage * 0.5 + confAvg * 0.3 + diversity * 0.2) * 100);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO entity_summary (
       entity_id, kind, display_name, primary_role, primary_employer, primary_employer_entity_id,
       country_iso2, region, city, sectors_csv, stages_csv, geos_csv,
       check_size_min_usd, check_size_max_usd, primary_email, primary_linkedin,
       primary_domain, quality_score, fit_max_score, intent_score, unicorn_count, status, rebuilt_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       kind = excluded.kind,
       display_name = excluded.display_name,
       primary_role = excluded.primary_role,
       primary_employer = excluded.primary_employer,
       primary_employer_entity_id = excluded.primary_employer_entity_id,
       country_iso2 = excluded.country_iso2,
       region = excluded.region,
       city = excluded.city,
       sectors_csv = excluded.sectors_csv,
       stages_csv = excluded.stages_csv,
       geos_csv = excluded.geos_csv,
       check_size_min_usd = excluded.check_size_min_usd,
       check_size_max_usd = excluded.check_size_max_usd,
       primary_email = excluded.primary_email,
       primary_linkedin = excluded.primary_linkedin,
       primary_domain = excluded.primary_domain,
       quality_score = excluded.quality_score,
       fit_max_score = excluded.fit_max_score,
       intent_score = excluded.intent_score,
       unicorn_count = excluded.unicorn_count,
       status = excluded.status,
       rebuilt_at = excluded.rebuilt_at`,
  ).bind(
    entityId, ent.kind, display, primaryRole, employerDisplay, employerEntityId,
    country, region, city,
    sectors.join(","), stages.join(","), geos.join(","),
    checkMin != null ? Math.round(checkMin) : null,
    checkMax != null ? Math.round(checkMax) : null,
    primaryEmailChan?.canonical ?? null,
    primaryLinkedinChan?.canonical ?? null,
    ent.primary_domain,
    quality, fitMax, intent, unicornCount, ent.status, now,
  ).run();

  // Update u_entities.quality_score + last_summary_at so list paths that
  // still read from `u_entities` see the latest score.
  await env.DB.prepare(`UPDATE u_entities SET quality_score = ?, last_summary_at = ?, updated_at = ? WHERE id = ?`)
    .bind(quality, now, now, entityId).run();

  return true;
}
