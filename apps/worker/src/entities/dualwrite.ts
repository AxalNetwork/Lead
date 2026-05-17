// Dual-write hooks. Every legacy writer calls one of these to mirror the
// row into the unified entity model. All hooks are best-effort: they
// log + swallow errors so a transient unified-model failure never blocks
// the legacy path.

import type { Env } from "../types";
import { createEntity, addRole, getLegacyEntityId, setLegacyEntityId } from "./roles";
import { insertFactsBatch, type FactPatch } from "./facts";
import { upsertChannel, findEntityByChannel } from "./channels";
import { addTag, addTagsFromJsonArray } from "./tags";
import { canonicalEmail, canonicalLinkedin, canonicalDomain } from "./normalize";
import { enqueueSummaryRebuild } from "./summaryQueue";
import type { EntityKind, EntityRole, ChannelKind, Taxonomy } from "./model";

interface FirmLikeInput {
  id: number | string;
  name: string;
  legal_name?: string | null;
  website?: string | null;
  domain?: string | null;
  hq_country_iso2?: string | null;
  hq_region?: string | null;
  hq_city?: string | null;
  check_size_min_usd?: number | null;
  check_size_max_usd?: number | null;
  check_size_typical_usd?: number | null;
  thesis?: string | null;
  linkedin_url?: string | null;
  crunchbase_url?: string | null;
  twitter_handle?: string | null;
  contact_email?: string | null;
  sectors_json?: string | null;
  stages_json?: string | null;
  geo_focus_json?: string | null;
  kind?: string | null;
}

interface LeadLikeInput {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  org?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  github_url?: string | null;
  personal_url?: string | null;
  country_iso2?: string | null;
  region?: string | null;
  city?: string | null;
  category?: string | null;
  investor_kind?: string | null;
  check_size_min_usd?: number | null;
  check_size_max_usd?: number | null;
  check_size_typical_usd?: number | null;
  sector_focus_json?: string | null;
  stage_focus_json?: string | null;
  geo_focus_json?: string | null;
  tags_json?: string | null;
  thesis?: string | null;
  bio?: string | null;
}

interface CompanyLikeInput {
  id: number | string;
  name: string;
  legal_name?: string | null;
  website?: string | null;
  domain?: string | null;
  hq_country_iso2?: string | null;
  hq_region?: string | null;
  hq_city?: string | null;
  stage?: string | null;
  industries_json?: string | null;
  unicorn?: number | null;
  linkedin_url?: string | null;
  crunchbase_url?: string | null;
  twitter_handle?: string | null;
  github_org?: string | null;
}

interface AccountLikeInput {
  id: string;
  name: string;
  legal_name?: string | null;
  website?: string | null;
  domain?: string | null;
  industry?: string | null;
  industries_json?: string | null;
  hq_country_iso2?: string | null;
  hq_region?: string | null;
  hq_city?: string | null;
  funding_stage?: string | null;
  linkedin_url?: string | null;
  twitter_handle?: string | null;
  github_org?: string | null;
  crunchbase_url?: string | null;
  fit_score?: number | null;
  intent_score?: number | null;
}

interface BuyerLikeInput {
  id: string;
  account_id: string;
  name?: string | null;
  email?: string | null;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  role_slug?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  phone?: string | null;
  is_decision_maker?: number | null;
}

async function resolveOrCreate(
  env: Env,
  table: "firms" | "leads" | "companies" | "accounts" | "buyers",
  legacyId: string | number,
  kind: EntityKind,
  init: Omit<Parameters<typeof createEntity>[1], "kind">,
  channelLookups: Array<{ kind: ChannelKind; raw: string | null | undefined }>,
): Promise<string | null> {
  const existing = await getLegacyEntityId(env, table, legacyId);
  if (existing) return existing;
  // Cross-link by strongest available identifier before creating new:
  // (a) deterministic domain match against u_entities.primary_domain
  // (orgs only — collapses firm/account/company duplicates sharing a
  // domain); (b) primary_email_key/primary_linkedin_key direct hits;
  // (c) channel-table reverse lookups for any other handle.
  if (kind === "org" && init.primary_domain) {
    const r = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_domain = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(init.primary_domain).first<{ id: string }>();
    if (r?.id) {
      await setLegacyEntityId(env, table, legacyId, r.id);
      return r.id;
    }
  }
  if (kind === "person" && init.primary_email_key) {
    const r = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_email_key = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(init.primary_email_key).first<{ id: string }>();
    if (r?.id) {
      await setLegacyEntityId(env, table, legacyId, r.id);
      return r.id;
    }
  }
  if (init.primary_linkedin_key) {
    const r = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_linkedin_key = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(init.primary_linkedin_key).first<{ id: string }>();
    if (r?.id) {
      await setLegacyEntityId(env, table, legacyId, r.id);
      return r.id;
    }
  }
  for (const ch of channelLookups) {
    if (!ch.raw) continue;
    const hit = await findEntityByChannel(env, ch.kind, ch.raw);
    if (hit) {
      await setLegacyEntityId(env, table, legacyId, hit);
      return hit;
    }
  }
  try {
    const created = await createEntity(env, { kind, ...init });
    await setLegacyEntityId(env, table, legacyId, created.id);
    return created.id;
  } catch (e) {
    console.warn("dualwrite createEntity failed", table, legacyId, (e as Error).message);
    return null;
  }
}

function chan(env: Env, entityId: string, kind: ChannelKind, raw: string | null | undefined, source: string, primary = false) {
  if (!raw) return Promise.resolve(null);
  return upsertChannel(env, { entity_id: entityId, kind, canonical: String(raw), source, is_primary: primary });
}

export async function syncFirmToEntity(
  env: Env,
  f: FirmLikeInput,
  source = "firms_upsert",
  sourceKind: "scrape" | "import" | "manual" | "enrichment" | "ai" | "inferred" = "scrape",
): Promise<string | null> {
  try {
    const domain = canonicalDomain(f.domain ?? f.website);
    const linkedin = canonicalLinkedin(f.linkedin_url);
    const entityId = await resolveOrCreate(env, "firms", f.id, "org", {
      display_name: f.name,
      primary_domain: domain,
      primary_url: f.website ?? null,
      primary_linkedin_key: linkedin,
    }, [
      { kind: "linkedin", raw: f.linkedin_url },
      { kind: "website", raw: f.website ?? null },
    ]);
    if (!entityId) return null;
    await addRole(env, entityId, "firm", { is_primary: true, source });
    if (f.kind && /accelerator/i.test(f.kind)) await addRole(env, entityId, "accelerator", { source });
    // Task #2: cascading role inference on the unified write path so
    // investor_firm / customer / prospect get assigned without each
    // call-site having to know.
    try {
      const { inferAndAssignRoles } = await import("../services/roleInference");
      await inferAndAssignRoles(env, entityId, {
        kind: "org",
        sourceKind,
        sourceUrl: f.website ?? null,
        sourceDomain: domain ?? null,
        org: f.name ?? null,
        category: f.kind ?? null,
        importLabel: source,
      });
    } catch (e) { console.warn("inferAndAssignRoles(firm) failed", entityId, (e as Error).message); }
    const patches: FactPatch[] = [
      { predicate: "name", value_text: f.name },
      { predicate: "legal_name", value_text: f.legal_name ?? null },
      { predicate: "domain", value_text: domain },
      { predicate: "website", value_text: f.website ?? null },
      { predicate: "country_iso2", value_text: f.hq_country_iso2 ?? null },
      { predicate: "region", value_text: f.hq_region ?? null },
      { predicate: "city", value_text: f.hq_city ?? null },
      { predicate: "thesis", value_text: f.thesis ?? null },
      { predicate: "kind", value_text: f.kind ?? null },
      { predicate: "check_size_min_usd", value_number: numOrNull(f.check_size_min_usd) },
      { predicate: "check_size_max_usd", value_number: numOrNull(f.check_size_max_usd) },
      { predicate: "check_size_typical_usd", value_number: numOrNull(f.check_size_typical_usd) },
    ];
    await insertFactsBatch(env, entityId, patches, source, sourceKind);
    await Promise.all([
      chan(env, entityId, "website", f.website, source, true),
      chan(env, entityId, "linkedin", f.linkedin_url, source, true),
      chan(env, entityId, "other", f.crunchbase_url, source),
      chan(env, entityId, "twitter", f.twitter_handle, source),
      chan(env, entityId, "email", f.contact_email, source),
    ]);
    await Promise.all([
      addTagsFromJsonArray(env, entityId, "sector", f.sectors_json, source),
      addTagsFromJsonArray(env, entityId, "stage", f.stages_json, source),
      addTagsFromJsonArray(env, entityId, "geo", f.geo_focus_json, source),
    ]);
    await enqueueSummaryRebuild(env, entityId);
    return entityId;
  } catch (e) {
    console.warn("syncFirmToEntity failed", f.id, (e as Error).message);
    return null;
  }
}

export async function syncLeadToEntity(
  env: Env,
  l: LeadLikeInput,
  source = "leads_repo",
  sourceKind: "scrape" | "import" | "manual" | "enrichment" | "ai" | "inferred" = "scrape",
): Promise<string | null> {
  try {
    const email = canonicalEmail(l.email);
    const linkedin = canonicalLinkedin(l.linkedin_url);
    const entityId = await resolveOrCreate(env, "leads", l.id, "person", {
      display_name: l.name ?? null,
      primary_email_key: email,
      primary_linkedin_key: linkedin,
      primary_url: l.personal_url ?? null,
    }, [
      { kind: "email", raw: l.email },
      { kind: "linkedin", raw: l.linkedin_url },
    ]);
    if (!entityId) return null;
    // Role inference: investor_kind set → investor; otherwise generic person.
    if (l.investor_kind) await addRole(env, entityId, "investor", { is_primary: true, source });
    if (l.category && /founder|ceo|cto/i.test(l.category)) await addRole(env, entityId, "founder", { source });
    // Task #2: cascading role inference on the unified write path. Runs
    // for every person sync so the Investors page (which reads from
    // entity_roles) picks up freshly-ingested people. Looks up the
    // person's company entity for partner-title inheritance.
    try {
      const { inferAndAssignRoles } = await import("../services/roleInference");
      await inferAndAssignRoles(env, entityId, {
        kind: "person",
        sourceKind,
        sourceUrl: l.personal_url ?? null,
        sourceDomain: null,
        title: l.title ?? null,
        org: l.org ?? null,
        category: l.category ?? null,
        importLabel: source,
      });
    } catch (e) { console.warn("inferAndAssignRoles(lead) failed", entityId, (e as Error).message); }
    const patches: FactPatch[] = [
      { predicate: "name", value_text: l.name ?? null },
      { predicate: "title", value_text: l.title ?? null },
      { predicate: "primary_employer", value_text: l.org ?? null },
      { predicate: "category", value_text: l.category ?? null },
      { predicate: "country_iso2", value_text: l.country_iso2 ?? null },
      { predicate: "region", value_text: l.region ?? null },
      { predicate: "city", value_text: l.city ?? null },
      { predicate: "bio", value_text: l.bio ?? null },
      { predicate: "thesis", value_text: l.thesis ?? null },
      { predicate: "investor_kind", value_text: l.investor_kind ?? null },
      { predicate: "check_size_min_usd", value_number: numOrNull(l.check_size_min_usd) },
      { predicate: "check_size_max_usd", value_number: numOrNull(l.check_size_max_usd) },
      { predicate: "check_size_typical_usd", value_number: numOrNull(l.check_size_typical_usd) },
    ];
    await insertFactsBatch(env, entityId, patches, source, sourceKind);
    await Promise.all([
      chan(env, entityId, "email", l.email, source, true),
      chan(env, entityId, "phone", l.phone, source),
      chan(env, entityId, "linkedin", l.linkedin_url, source, true),
      chan(env, entityId, "twitter", l.twitter_url, source),
      chan(env, entityId, "github", l.github_url, source),
      chan(env, entityId, "website", l.personal_url, source),
    ]);
    await Promise.all([
      addTagsFromJsonArray(env, entityId, "sector", l.sector_focus_json, source),
      addTagsFromJsonArray(env, entityId, "stage", l.stage_focus_json, source),
      addTagsFromJsonArray(env, entityId, "geo", l.geo_focus_json, source),
      addTagsFromJsonArray(env, entityId, "tag", l.tags_json, source),
    ]);
    await enqueueSummaryRebuild(env, entityId);
    return entityId;
  } catch (e) {
    console.warn("syncLeadToEntity failed", l.id, (e as Error).message);
    return null;
  }
}

export async function syncCompanyToEntity(env: Env, c: CompanyLikeInput, source = "companies"): Promise<string | null> {
  try {
    const domain = canonicalDomain(c.domain ?? c.website);
    const linkedin = canonicalLinkedin(c.linkedin_url);
    const entityId = await resolveOrCreate(env, "companies", c.id, "org", {
      display_name: c.name,
      primary_domain: domain,
      primary_url: c.website ?? null,
      primary_linkedin_key: linkedin,
    }, [
      { kind: "linkedin", raw: c.linkedin_url },
      { kind: "website", raw: c.website ?? null },
    ]);
    if (!entityId) return null;
    await addRole(env, entityId, "company", { is_primary: true, source });
    const patches: FactPatch[] = [
      { predicate: "name", value_text: c.name },
      { predicate: "legal_name", value_text: c.legal_name ?? null },
      { predicate: "domain", value_text: domain },
      { predicate: "website", value_text: c.website ?? null },
      { predicate: "country_iso2", value_text: c.hq_country_iso2 ?? null },
      { predicate: "region", value_text: c.hq_region ?? null },
      { predicate: "city", value_text: c.hq_city ?? null },
      { predicate: "stage", value_text: c.stage ?? null },
      { predicate: "unicorn_count", value_number: c.unicorn ? 1 : 0 },
    ];
    await insertFactsBatch(env, entityId, patches, source, "scrape");
    await Promise.all([
      chan(env, entityId, "website", c.website, source, true),
      chan(env, entityId, "linkedin", c.linkedin_url, source),
      chan(env, entityId, "twitter", c.twitter_handle, source),
      chan(env, entityId, "github", c.github_org, source),
      chan(env, entityId, "other", c.crunchbase_url, source),
    ]);
    await addTagsFromJsonArray(env, entityId, "sector", c.industries_json, source);
    if (c.stage) await addTag(env, { entity_id: entityId, taxonomy: "stage", slug: c.stage, source });
    await enqueueSummaryRebuild(env, entityId);
    return entityId;
  } catch (e) {
    console.warn("syncCompanyToEntity failed", c.id, (e as Error).message);
    return null;
  }
}

export async function syncAccountToEntity(env: Env, a: AccountLikeInput, source = "accounts"): Promise<string | null> {
  try {
    const domain = canonicalDomain(a.domain ?? a.website);
    const linkedin = canonicalLinkedin(a.linkedin_url);
    const entityId = await resolveOrCreate(env, "accounts", a.id, "org", {
      display_name: a.name,
      primary_domain: domain,
      primary_url: a.website ?? null,
      primary_linkedin_key: linkedin,
    }, [
      { kind: "linkedin", raw: a.linkedin_url },
      { kind: "website", raw: a.website ?? null },
    ]);
    if (!entityId) return null;
    await addRole(env, entityId, "account", { is_primary: true, source });
    const patches: FactPatch[] = [
      { predicate: "name", value_text: a.name },
      { predicate: "legal_name", value_text: a.legal_name ?? null },
      { predicate: "domain", value_text: domain },
      { predicate: "website", value_text: a.website ?? null },
      { predicate: "country_iso2", value_text: a.hq_country_iso2 ?? null },
      { predicate: "region", value_text: a.hq_region ?? null },
      { predicate: "city", value_text: a.hq_city ?? null },
      { predicate: "industry", value_text: a.industry ?? null },
      { predicate: "funding_stage", value_text: a.funding_stage ?? null },
      { predicate: "fit_max_score", value_number: numOrNull(a.fit_score) },
      { predicate: "intent_score", value_number: numOrNull(a.intent_score) },
    ];
    await insertFactsBatch(env, entityId, patches, source, "scrape");
    await Promise.all([
      chan(env, entityId, "website", a.website, source, true),
      chan(env, entityId, "linkedin", a.linkedin_url, source),
      chan(env, entityId, "twitter", a.twitter_handle, source),
      chan(env, entityId, "github", a.github_org, source),
      chan(env, entityId, "other", a.crunchbase_url, source),
    ]);
    await addTagsFromJsonArray(env, entityId, "sector", a.industries_json, source);
    if (a.industry) await addTag(env, { entity_id: entityId, taxonomy: "sector" as Taxonomy, slug: a.industry, source });
    await enqueueSummaryRebuild(env, entityId);
    return entityId;
  } catch (e) {
    console.warn("syncAccountToEntity failed", a.id, (e as Error).message);
    return null;
  }
}

export async function syncBuyerToEntity(env: Env, b: BuyerLikeInput, source = "buyers"): Promise<string | null> {
  try {
    const email = canonicalEmail(b.email);
    const linkedin = canonicalLinkedin(b.linkedin_url);
    const entityId = await resolveOrCreate(env, "buyers", b.id, "person", {
      display_name: b.name ?? null,
      primary_email_key: email,
      primary_linkedin_key: linkedin,
    }, [
      { kind: "email", raw: b.email },
      { kind: "linkedin", raw: b.linkedin_url },
    ]);
    if (!entityId) return null;
    await addRole(env, entityId, "buyer", { is_primary: true, source });
    if (b.is_decision_maker) await addRole(env, entityId, "executive" as EntityRole, { source });
    // Link buyer → account via 'works_at' edge.
    const accountEntityId = await getLegacyEntityId(env, "accounts", b.account_id);
    if (accountEntityId) {
      await env.DB.prepare(
        `INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, source)
         VALUES (?, ?, ?, 'works_at', ?)
         ON CONFLICT(src_entity_id, dst_entity_id, kind, IFNULL(valid_from,'')) DO NOTHING`,
      ).bind(crypto.randomUUID(), entityId, accountEntityId, source).run().catch(() => undefined);
      // Also write as a fact for summary.primary_employer_entity_id pickup.
      await insertFactsBatch(env, entityId, [{ predicate: "employer", value_entity_id: accountEntityId }], source, "inferred");
    }
    const patches: FactPatch[] = [
      { predicate: "name", value_text: b.name ?? null },
      { predicate: "title", value_text: b.title ?? null },
      { predicate: "seniority", value_text: b.seniority ?? null },
      { predicate: "department", value_text: b.department ?? null },
      { predicate: "role_slug", value_text: b.role_slug ?? null },
    ];
    await insertFactsBatch(env, entityId, patches, source, "scrape");
    await Promise.all([
      chan(env, entityId, "email", b.email, source, true),
      chan(env, entityId, "linkedin", b.linkedin_url, source, true),
      chan(env, entityId, "twitter", b.twitter_url, source),
      chan(env, entityId, "phone", b.phone, source),
    ]);
    if (b.role_slug) await addTag(env, { entity_id: entityId, taxonomy: "role", slug: b.role_slug, source });
    await enqueueSummaryRebuild(env, entityId);
    return entityId;
  } catch (e) {
    console.warn("syncBuyerToEntity failed", b.id, (e as Error).message);
    return null;
  }
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
