// Merge logic: combine an incoming parsed lead into an existing one. The
// existing row stays as the surviving primary (its id never changes); we
// patch in any new evidence using LeadsRepo.updateLead so the audit log
// captures every promotion. Multi-value fields (companies, awards, alt
// emails) are unioned by canonical key; per-field winners use provider
// priority then recency.

import type { Lead, LeadPatch } from "../db/leads.types";
import { LeadsRepo, type UpdateContext } from "../db/leads.repo";

const PROVIDER_PRIORITY: Record<string, number> = {
  manual: 100,
  crunchbase: 80,
  pitchbook: 80,
  linkedin: 70,
  "sec-edgar": 75,
  opencorporates: 70,
  "gov-registry": 70,
  "personal-site": 50,
  linktree: 40,
  beacons: 40,
  generic: 30,
};

function providerWeight(p: string | null | undefined): number {
  if (!p) return 0;
  return PROVIDER_PRIORITY[p.toLowerCase()] ?? 0;
}

function pickScalar<T>(
  current: T | null | undefined,
  incoming: T | null | undefined,
  currentProvider: string | null | undefined,
  incomingProvider: string | null | undefined,
): T | null | undefined {
  if (incoming == null || incoming === "") return current;
  if (current == null || current === "") return incoming;
  if (current === incoming) return current;
  // Prefer higher-priority provider, fallback to incoming on tie (newer).
  const cw = providerWeight(currentProvider);
  const iw = providerWeight(incomingProvider);
  return iw >= cw ? incoming : current;
}

function unionStringArray(
  currentJson: string | null | undefined,
  incomingValues: string[] | undefined,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  if (currentJson) {
    try {
      const arr = JSON.parse(currentJson);
      if (Array.isArray(arr)) {
        for (const v of arr) {
          const s = String(v).toLowerCase();
          if (!seen.has(s)) {
            seen.add(s);
            out.push(String(v));
          }
        }
      }
    } catch {
      // ignore
    }
  }
  if (incomingValues) {
    for (const v of incomingValues) {
      const s = String(v).toLowerCase();
      if (!seen.has(s)) {
        seen.add(s);
        out.push(v);
      }
    }
  }
  return JSON.stringify(out);
}

export interface IncomingLead {
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  github_url?: string | null;
  personal_url?: string | null;
  name?: string | null;
  org?: string | null;
  title?: string | null;
  category?: string | null;
  bio?: string | null;
  country_iso2?: string | null;
  region?: string | null;
  city?: string | null;
  timezone?: string | null;
  source_domain?: string | null;
  source_url?: string | null;
  alt_emails?: string[];
  tags?: string[];
  provider?: string | null;
}

/**
 * Merge incoming evidence into an existing lead. Returns the number of
 * fields that actually changed.
 */
export async function mergeIntoExisting(
  db: D1Database,
  existing: Lead,
  incoming: IncomingLead,
  ctx: UpdateContext,
  flags: { dncHit?: boolean } = {},
): Promise<number> {
  const repo = new LeadsRepo(db);

  const patch: LeadPatch = {};

  const scalarFields: Array<keyof IncomingLead & keyof Lead> = [
    "email", "phone", "linkedin_url", "twitter_url", "github_url", "personal_url",
    "name", "org", "title", "category", "bio",
    "country_iso2", "region", "city", "timezone",
  ];
  const existingRec = existing as unknown as Record<string, unknown>;
  const patchRec = patch as unknown as Record<string, unknown>;
  for (const f of scalarFields) {
    const next = pickScalar(
      existingRec[f] as string | null | undefined,
      incoming[f] as string | null | undefined,
      existing.provider,
      incoming.provider,
    );
    if (next !== existingRec[f]) {
      patchRec[f] = next;
    }
  }

  // alt_emails: union with the incoming primary email + alt list.
  const altIn: string[] = [];
  if (incoming.email && incoming.email !== existing.email) altIn.push(incoming.email);
  if (incoming.alt_emails) altIn.push(...incoming.alt_emails);
  if (altIn.length > 0) {
    const merged = unionStringArray(existing.alt_emails_json ?? null, altIn);
    if (merged !== (existing.alt_emails_json ?? "[]")) patch.alt_emails_json = merged;
  }

  if (incoming.tags && incoming.tags.length > 0) {
    const merged = unionStringArray(existing.tags_json ?? null, incoming.tags);
    if (merged !== (existing.tags_json ?? "[]")) patch.tags_json = merged;
  }

  // Provenance updates
  if (incoming.provider && providerWeight(incoming.provider) >= providerWeight(existing.provider)) {
    patch.provider = incoming.provider;
  }

  // Bump canonical keys if any participating field moved.
  const keys = await import("./keys");
  const finalName = ("name" in patch ? (patch.name as string | null) : existing.name) ?? null;
  const finalOrg = ("org" in patch ? (patch.org as string | null) : existing.org) ?? null;
  const finalCity = ("city" in patch ? (patch.city as string | null) : existing.city ?? null) ?? null;

  if ("email" in patch) {
    patch.canonical_email_key = keys.canonicalEmailKey((patch.email as string) ?? existing.email);
  }
  if ("phone" in patch) {
    patch.canonical_phone_key = keys.canonicalPhoneKey((patch.phone as string) ?? existing.phone ?? null);
  }
  if ("linkedin_url" in patch) {
    patch.canonical_linkedin_key = keys.canonicalLinkedinKey(
      (patch.linkedin_url as string) ?? existing.linkedin_url ?? null,
    );
  }
  // name+firm / name+city composite keys move whenever any participant changes.
  if ("name" in patch || "org" in patch) {
    patch.canonical_name_firm_key = keys.canonicalNameFirmKey(finalName, finalOrg);
  }
  if ("name" in patch || "city" in patch) {
    patch.canonical_name_city_key = keys.canonicalNameCityKey(finalName, finalCity);
  }

  // GDPR/CAN-SPAM: if the incoming evidence was DNC-scrubbed, force the
  // surviving lead onto the do-not-contact list and null any matching PII
  // fields so the merge can't reintroduce suppressed contact info.
  if (flags.dncHit) {
    (patch as unknown as Record<string, unknown>).do_not_contact = 1;
    if (existing.email && !("email" in patch)) (patch as unknown as Record<string, unknown>).email = null;
    if (existing.phone && !("phone" in patch)) (patch as unknown as Record<string, unknown>).phone = null;
    if (existing.linkedin_url && !("linkedin_url" in patch)) (patch as unknown as Record<string, unknown>).linkedin_url = null;
  }

  return repo.updateLead(existing.id, patch, { ...ctx, source: ctx.source || "dedupe_merge" });
}

/**
 * Mark a duplicate row as merged into a primary. Used when two existing leads
 * are reconciled by the manual review UI.
 */
export async function markMerged(
  db: D1Database,
  primaryId: string,
  duplicateId: string,
  ctx: UpdateContext,
): Promise<void> {
  const repo = new LeadsRepo(db);
  await repo.updateLead(
    duplicateId,
    { merged_into: primaryId, status: "merged" },
    { ...ctx, source: ctx.source || "dedupe_merge" },
  );
}
