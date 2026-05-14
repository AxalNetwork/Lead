import type { Env } from "../types";

interface RobotsRules {
  /** Disallow path prefixes that apply to our user agent (we honor User-agent: *). */
  disallow: string[];
  /** Allow path prefixes (longer matches override Disallow per RFC). */
  allow: string[];
  /** Per-spec crawl-delay in seconds, if declared. */
  crawlDelay: number | null;
  /** ISO timestamp of when this snapshot was taken. */
  fetched_at: string;
}

const KV_TTL_SECONDS = 24 * 3600;

function parseRobots(text: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelay: number | null }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[]; crawlDelay: number | null } | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current) {
      lastWasAgent = false;
      if (field === "disallow" && value) current.disallow.push(value);
      else if (field === "allow" && value) current.allow.push(value);
      else if (field === "crawl-delay") {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
    }
  }

  // Pick the wildcard group; fall back to merging all groups if none.
  const star = groups.filter((g) => g.agents.includes("*"));
  const chosen = star.length ? star : groups;
  const disallow: string[] = [];
  const allow: string[] = [];
  let crawlDelay: number | null = null;
  for (const g of chosen) {
    disallow.push(...g.disallow);
    allow.push(...g.allow);
    if (g.crawlDelay !== null) crawlDelay = Math.max(crawlDelay ?? 0, g.crawlDelay);
  }
  return { disallow, allow, crawlDelay, fetched_at: new Date().toISOString() };
}

async function loadRules(env: Env, host: string): Promise<RobotsRules> {
  const key = `robots:${host}`;
  const cached = await env.SCRAPE_CACHE.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as RobotsRules;
    } catch {
      // fall through and refetch
    }
  }
  let rules: RobotsRules;
  try {
    const res = await fetch(`https://${host}/robots.txt`, {
      method: "GET",
      headers: { "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)" },
      cf: { cacheTtl: KV_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (res.ok) {
      const text = await res.text();
      rules = parseRobots(text);
    } else {
      // Treat missing robots.txt as fully permissive (RFC 9309 §2.3.1.3).
      rules = { disallow: [], allow: [], crawlDelay: null, fetched_at: new Date().toISOString() };
    }
  } catch {
    rules = { disallow: [], allow: [], crawlDelay: null, fetched_at: new Date().toISOString() };
  }
  await env.SCRAPE_CACHE.put(key, JSON.stringify(rules), { expirationTtl: KV_TTL_SECONDS });
  return rules;
}

function pathMatches(rule: string, path: string): number {
  // Returns the length of the matched prefix, or 0 for no match. Supports
  // `*` (any sequence) and `$` (end of path) per Google's extension.
  if (!rule) return 0;
  const hasWildcard = rule.includes("*") || rule.endsWith("$");
  if (!hasWildcard) {
    return path.startsWith(rule) ? rule.length : 0;
  }
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
  const re = new RegExp("^" + escaped);
  const m = re.exec(path);
  return m ? m[0].length : 0;
}

export interface RobotsDecision {
  allowed: boolean;
  reason: string | null;
  crawlDelayMs: number;
}

/**
 * Check whether `url` may be fetched under the wildcard robots policy of the
 * host. Returns the recommended crawl-delay in milliseconds (0 if unset).
 * Cached for 24h per-host in KV.
 */
export async function checkRobots(env: Env, url: string): Promise<RobotsDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid_url", crawlDelayMs: 0 };
  }
  const rules = await loadRules(env, parsed.hostname.toLowerCase());
  const path = parsed.pathname + parsed.search;
  let bestAllow = 0;
  let bestDisallow = 0;
  for (const r of rules.allow) bestAllow = Math.max(bestAllow, pathMatches(r, path));
  for (const r of rules.disallow) bestDisallow = Math.max(bestDisallow, pathMatches(r, path));
  const blocked = bestDisallow > 0 && bestDisallow > bestAllow;
  return {
    allowed: !blocked,
    reason: blocked ? "robots_disallow" : null,
    crawlDelayMs: rules.crawlDelay ? Math.round(rules.crawlDelay * 1000) : 0,
  };
}
