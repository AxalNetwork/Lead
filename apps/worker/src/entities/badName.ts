// Task #4 (and Task #5 backfill consumer): single source of truth for
// "this entity name looks like a type/category, not a real name".
//
// Task #5 owns the backfill migration + write-side safeguard; Task #4
// reuses the same predicate on the read path so the profile header
// can fall back to a domain-derived display name.
//
// IMPORTANT: a sibling copy of this module lives at
// apps/site/assets/js/profile-bad-names.js. Keep them in sync.

const BAD_NAME_LITERALS = new Set<string>([
  "vc", "pe", "lp", "gp", "llc", "inc", "co", "corp", "ltd", "plc",
  "firm", "fund", "company", "organization", "org", "nonprofit",
  "non-profit", "training program", "training",
  "accelerator", "incubator", "investor", "angel", "angel group",
  "family office", "corp vc", "gov fund",
]);

// Matches strings that look like a list of types/categories, e.g.
// "Nonprofit, Training Program" or "VC, Accelerator".
const BAD_NAME_LIST_RE = /^[a-z][a-z\s/&-]{1,40}(?:,\s*[a-z][a-z\s/&-]{1,40})+$/i;

/**
 * Returns true when `name` is unsuitable for a profile header — empty,
 * too short, or matches a known type/category pattern.
 */
export function isBadEntityName(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = String(name).trim();
  if (trimmed.length < 3) return true;
  const lower = trimmed.toLowerCase();
  if (BAD_NAME_LITERALS.has(lower)) return true;
  if (BAD_NAME_LIST_RE.test(trimmed)) return true;
  return false;
}

/**
 * Best-effort title-case display from a primary_domain or primary_url.
 * `firstround.com` → `First Round`, `amplifyher.vc` → `Amplifyher`.
 * Returns null when no usable host is available.
 */
export function displayFromDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host: string;
  try {
    host = new URL(input.includes("://") ? input : `https://${input}`).hostname;
  } catch {
    host = String(input);
  }
  host = host.replace(/^www\./i, "").trim();
  if (!host) return null;
  const stem = host.split(".").slice(0, -1).join(".") || host;
  if (!stem) return null;
  return stem
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
