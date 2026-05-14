// Canonicalization helpers used to produce dedupe keys. All inputs are
// normalized aggressively so trivial variations (case, punctuation,
// query strings) collapse to the same key.

import { canonicalizeLinkedinUrl, emailDedupeKey, normalizePhoneE164 } from "../scraper/normalize";

export function canonicalEmailKey(email: string | null | undefined): string | null {
  return emailDedupeKey(email ?? "");
}

export function canonicalPhoneKey(phone: string | null | undefined): string | null {
  return normalizePhoneE164(phone ?? "");
}

export function canonicalLinkedinKey(url: string | null | undefined): string | null {
  const c = canonicalizeLinkedinUrl(url ?? null);
  return c ? c.toLowerCase() : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ORG_SUFFIXES = /\b(inc|llc|ltd|gmbh|sa|corp|corporation|company|co|plc|pte|limited)\b\.?/gi;

export function canonicalOrg(org: string | null | undefined): string | null {
  if (!org) return null;
  const cleaned = org.replace(ORG_SUFFIXES, " ").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  return slugify(cleaned) || null;
}

export function canonicalName(name: string | null | undefined): string | null {
  if (!name) return null;
  return slugify(name) || null;
}

export function canonicalNameFirmKey(
  name: string | null | undefined,
  org: string | null | undefined,
): string | null {
  const n = canonicalName(name);
  const o = canonicalOrg(org);
  if (!n || !o) return null;
  return `${n}|${o}`;
}

export function canonicalNameCityKey(
  name: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const n = canonicalName(name);
  const c = city ? slugify(city) : null;
  if (!n || !c) return null;
  return `${n}|${c}`;
}
