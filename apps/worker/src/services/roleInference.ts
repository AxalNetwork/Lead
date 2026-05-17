import type { Env } from "../types";
import type { EntityRole } from "../entities/model";

export interface RoleInferenceContext {
  sourceKind?: "scrape" | "import" | "manual" | "enrichment" | "ai" | "inferred";
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  title?: string | null;
  org?: string | null;
  kind?: "person" | "org";
  category?: string | null;
  importLabel?: string | null;
}

// Static fallback list used when known_investor_domains is empty or
// unavailable. Kept in sync with migration 333's seed list so the
// behavior is identical pre- and post-backfill.
const VC_DOMAINS_STATIC = new Set([
  "a16z.com", "andreessenhorowitz.com", "andreesenhorowitz.com",
  "sequoiacap.com", "accel.com", "kpcb.com", "benchmark.com",
  "greylock.com", "firstround.com", "foundersfund.com", "crv.com",
  "usv.com", "union.vc", "indexventures.com", "sparkcapital.com",
  "generalcatalyst.com", "incubatefund.com",
]);

let DOMAIN_CACHE: { at: number; set: Set<string> } | null = null;
const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadKnownInvestorDomains(env: Env): Promise<Set<string>> {
  if (DOMAIN_CACHE && Date.now() - DOMAIN_CACHE.at < DOMAIN_CACHE_TTL_MS) return DOMAIN_CACHE.set;
  const set = new Set<string>(VC_DOMAINS_STATIC);
  try {
    const r = await env.DB.prepare("SELECT domain FROM known_investor_domains").all<{ domain: string }>();
    for (const row of r.results ?? []) {
      if (row.domain) set.add(row.domain.toLowerCase());
    }
  } catch { /* table missing pre-migration — fall back to static */ }
  DOMAIN_CACHE = { at: Date.now(), set };
  return set;
}

function normalize(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase();
}

function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^www\./, "").toLowerCase();
  }
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

export async function inferAndAssignRoles(env: Env, entityId: string, ctx: RoleInferenceContext): Promise<void> {
  const roles: Array<{ role: EntityRole; confidence: number }> = [];
  const text = [ctx.title, ctx.org, ctx.category, ctx.importLabel].map(normalize).join(" ");
  const domain = domainOf(ctx.sourceDomain ?? ctx.sourceUrl ?? null);
  const sourceKind = ctx.sourceKind ?? "inferred";

  if (ctx.kind === "person") {
    roles.push({ role: "lead", confidence: 1 });
  }

  if (ctx.importLabel && /investor/i.test(ctx.importLabel)) {
    if (ctx.kind === "person") roles.push({ role: "investor", confidence: 0.95 });
    if (ctx.kind === "org") roles.push({ role: "investor_firm", confidence: 0.95 });
  }

  if (domain) {
    const known = await loadKnownInvestorDomains(env);
    if (known.has(domain)) {
      if (ctx.kind === "org") roles.push({ role: "investor_firm", confidence: 0.95 });
      if (ctx.kind === "person") roles.push({ role: "investor", confidence: 0.9 });
    }
  }

  if (hasAny(text, ["portfolio companies", "we invest in", "our fund", "aum", "check size"])) {
    if (ctx.kind === "org") roles.push({ role: "investor_firm", confidence: 0.85 });
    if (ctx.kind === "person") roles.push({ role: "investor", confidence: 0.8 });
  }

  // Partner/principal title — high confidence only if the person's
  // company entity is itself flagged as an investor_firm. Otherwise
  // (no company context) we still emit a lower-confidence guess based
  // on title keywords alone.
  if (ctx.kind === "person" && hasAny(text, ["partner", "principal", "associate", "venture", "investor", " gp ", "managing director"])) {
    let atInvestorFirm = false;
    if (ctx.org) {
      try {
        const row = await env.DB
          .prepare(
            `SELECT 1 AS n
               FROM firms f
               JOIN entity_legacy_map m ON m.legacy_table = 'firms' AND m.legacy_id = CAST(f.id AS TEXT)
               JOIN entity_roles r     ON r.entity_id = m.entity_id AND r.role = 'investor_firm'
              WHERE LOWER(f.name) = LOWER(?) LIMIT 1`,
          )
          .bind(ctx.org).first<{ n: number }>();
        atInvestorFirm = !!row;
      } catch { /* best-effort */ }
    }
    roles.push({ role: "investor", confidence: atInvestorFirm ? 0.95 : 0.7 });
  }

  if (hasAny(text, ["customers", "case studies", "trusted by", "used by"])) {
    roles.push({ role: "customer", confidence: 0.7 });
  }

  if (hasAny(text, ["hiring", "sales", "product", "open roles", "we're hiring", "we are hiring"])) {
    roles.push({ role: "prospect", confidence: 0.65 });
  }

  const seen = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.role)) continue;
    seen.add(role.role);
    // Provenance-safe write: never overwrite a role row whose source
    // came from a non-inference path (manual, importer-explicit, etc).
    // We INSERT OR IGNORE first (cheap), then bump confidence ONLY when
    // the existing row was also written by role_inference.
    const src = `role_inference:v1:${sourceKind}`;
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        entityId, role.role,
        role.role === "lead" || role.role === "investor_firm" || role.role === "investor" ? 1 : 0,
        src, role.confidence,
      ).run();
      await env.DB.prepare(
        `UPDATE entity_roles
            SET confidence = MAX(confidence, ?),
                source     = ?
          WHERE entity_id = ? AND role = ?
            AND source LIKE 'role_inference:%'`,
      ).bind(role.confidence, src, entityId, role.role).run();
    } catch (e) {
      console.warn("inferAndAssignRoles addRole failed", role.role, (e as Error).message);
    }
  }
}
