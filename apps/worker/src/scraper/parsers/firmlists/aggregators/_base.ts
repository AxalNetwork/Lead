import type { Env } from "../../../../types";
import type { FirmCandidate, ImporterHints } from "../types";
import { limitHost } from "../../../rateLimit";

/**
 * Task #2 — Shared framework for structured aggregator importers
 * (vcsheet, vcstack, failory, landscape.vc, climatescape,
 * mountsideventures, foundersnextmove, plus the legacy openvc /
 * mercury / versatilevc / nyc_founder_guide that route through this
 * helper for signup-wall detection and hint application).
 *
 * Per-importer overrides:
 *   - Page budget (max pages walked when paginating an index) read from
 *     `env.AGG_{NAME}_MAX_PAGES` (string, integer). Falls back to the
 *     `defaultBudget` supplied by the importer.
 *   - Host rate limit honored via `awaitHostSlot(env, url)` — backed by
 *     the `RL_HOST` Cloudflare Rate Limiter binding (60/min) and a KV
 *     leaky-bucket fallback. Aggregator importers walk many pages of
 *     the same host so they must pace themselves explicitly; the
 *     `fetchPage` tier does NOT call `limitHost` today.
 */

/** Alias kept for backward-compat: identical shape to `ImporterHints`. */
export type AggregatorHints = ImporterHints;

/**
 * Task #2: shared aggregator-importer contract. Each new aggregator
 * implements this interface — the registry routes URLs to the right
 * importer via `urlPattern` and the pipeline calls `hydrate(url, env,
 * hints)` which yields raw records lazily. The existing
 * `FirmlistImporter` shim wraps the generator into the buffered
 * `FirmlistImportResult` the pipeline already consumes, so we can
 * adopt the generator pattern site-by-site without forking the
 * pipeline.
 */
export interface RawRecord {
  name: string;
  website?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  thesis?: string | null;
  geo?: string | null;
  city?: string | null;
  country?: string | null;
  stage?: string | null;
  sector?: string | null;
  check_size?: string | null;
  source_url?: string | null;
  /** Additional importer-specific fields preserved verbatim. */
  [k: string]: unknown;
}

export interface AggregatorImporter {
  id: string;
  urlPattern: RegExp;
  hydrate(url: string, env: Env, hints?: ImporterHints): AsyncGenerator<RawRecord, void, void>;
}

/** Page-budget lookup for paginated aggregators. */
export function pageBudget(env: Env, name: string, defaultBudget: number): number {
  const key = `AGG_${name.toUpperCase()}_MAX_PAGES`;
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.min(n, 100);
  return defaultBudget;
}

/**
 * Pause until the per-host rate limiter says we have a free slot AND
 * at least `AGG_HOST_MIN_INTERVAL_MS` (default 3000ms) has elapsed
 * since the last aggregator request to the same host. The 3s gap is
 * required by the Task #2 contract (≤ 1 req / 3s per host). We back
 * it with the SCRAPE_CACHE KV namespace so the pacing survives across
 * worker isolates / cron invocations.
 */
const HOST_MIN_INTERVAL_MS_DEFAULT = 3_000;
const HOST_LAST_FETCH_PREFIX = "agg:last_fetch:";

export async function awaitHostSlot(env: Env, url: string): Promise<void> {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  if (!host) return;

  // 3s per-host pacing.
  const minInterval = (() => {
    const raw = (env as unknown as Record<string, string | undefined>).AGG_HOST_MIN_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : HOST_MIN_INTERVAL_MS_DEFAULT;
  })();
  const kv = (env as unknown as { SCRAPE_CACHE?: KVNamespace }).SCRAPE_CACHE;
  if (kv && minInterval > 0) {
    const key = `${HOST_LAST_FETCH_PREFIX}${host}`;
    try {
      const raw = await kv.get(key);
      const last = raw ? Number(raw) : 0;
      const now = Date.now();
      const wait = last + minInterval - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, minInterval)));
      await kv.put(key, String(Date.now()), { expirationTtl: 300 });
    } catch { /* swallow — fall through to the limitHost check */ }
  }

  // Secondary check against the existing per-host limiter (60/min).
  for (let i = 0; i < 6; i++) {
    const ok = await limitHost(env, host);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Heuristic: returns a short reason string when the page is gated behind
 *  a signup / paywall, else null. Aggregator importers should fail-soft
 *  by returning the warning in `errors` instead of throwing. */
export function detectSignupWall(html: string, url: string): string | null {
  if (!html) return null;
  const lo = html.toLowerCase();
  // URL hints
  if (/[?&](signup|register|subscribe|login)\b/i.test(url)) return `signup_required:url_hint`;
  // Body hints — match prominent wall copy that aggregators commonly use.
  const hits: string[] = [];
  if (/sign\s*up\s+to\s+(see|view|access|continue|read|unlock)/.test(lo)) hits.push("signup_to_view");
  if (/create\s+(a\s+)?free\s+account/.test(lo) && /to\s+(see|view|access|unlock)/.test(lo)) hits.push("free_account_required");
  if (/this\s+(content|list|database)\s+is\s+(for\s+)?(members|subscribers)/.test(lo)) hits.push("members_only");
  if (/login\s+(required|to\s+continue)/.test(lo)) hits.push("login_required");
  if (/paywall/.test(lo)) hits.push("paywall");
  if (!hits.length) return null;
  return `signup_required:${hits.join(",")}`;
}

/** Apply hints to a firm: fill missing geo/kind fields and append the
 *  hint slugs to `firm.tags` so the pipeline can tag the unified entity. */
export function applyHints(firm: FirmCandidate, hints: AggregatorHints | undefined | null): FirmCandidate {
  if (!hints) return firm;
  const tagSet = new Set<string>(Array.isArray((firm as { tags?: string[] }).tags) ? (firm as { tags?: string[] }).tags! : []);
  if (hints.role) tagSet.add(`role:${hints.role}`);
  if (hints.sector) tagSet.add(`sector:${hints.sector}`);
  if (hints.geo) tagSet.add(`geo:${hints.geo}`);
  if (hints.country_iso2) {
    if (!firm.hq_country_iso2) firm.hq_country_iso2 = hints.country_iso2.toUpperCase();
    tagSet.add(`country:${hints.country_iso2.toUpperCase()}`);
  }
  if (hints.region) {
    if (!firm.hq_region) firm.hq_region = hints.region;
    tagSet.add(`region:${hints.region.toLowerCase().replace(/\s+/g, "_")}`);
  }
  if (hints.kind && !firm.kind) firm.kind = hints.kind;
  (firm as { tags?: string[] }).tags = [...tagSet];
  return firm;
}

/** Build a stable `import_key` from a firm name + a per-importer namespace.
 *  The pipeline uses this key to apply `firm.tags` after upsert. */
export function importKey(namespace: string, slugSource: string): string {
  const s = slugSource.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${namespace}:${s || "unknown"}`;
}

/** Convert a relative href into an absolute URL against a base; returns
 *  null when the input isn't a valid URL. */
export function absoluteUrl(href: string, base: string): string | null {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}
