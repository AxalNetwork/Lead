import type { Env } from "../types";
import { addRole } from "../entities/roles";
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

const VC_DOMAINS = new Set(["firstround.com", "a16z.com", "sequoiacap.com", "accel.com", "kpcb.com", "benchmark.com", "greylock.com", "benchmark.com", "andreesenhorowitz.com", "andreessenhorowitz.com", "union.vc", "foundersfund.com", "crv.com", "usv.com", "sequoiacap.com", "indexventures.com", "sparkcapital.com", "generalcatalyst.com"]);

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

  if (domain && VC_DOMAINS.has(domain)) {
    if (ctx.kind === "org") roles.push({ role: "investor_firm", confidence: 0.95 });
    if (ctx.kind === "person") roles.push({ role: "investor", confidence: 0.9 });
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
    await addRole(env, entityId, role.role, {
      confidence: role.confidence,
      source: `role_inference:v1:${sourceKind}`,
      is_primary: role.role === "lead" || role.role === "investor_firm" || role.role === "investor",
    });
  }
}
