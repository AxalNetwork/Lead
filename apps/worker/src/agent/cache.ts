// Task #3: per-tool result cache.
//
// Tool-call results are cached in SCRAPE_CACHE KV under `cache:{tool}:{hash}`
// with a 5-minute TTL. Cache hits are recorded as zero-token tool
// invocations so they still appear in the agent-steps panel for
// transparency.

import type { Env } from "../types";

const TTL = 300;

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheKey(tool: string, args: unknown): Promise<string> {
  const norm = JSON.stringify(args ?? {});
  const h = await sha256Hex(`${tool}:${norm}`);
  return `cache:${tool}:${h.slice(0, 32)}`;
}

export async function cacheGet<T>(env: Env, key: string): Promise<T | null> {
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cachePut(env: Env, key: string, value: unknown): Promise<void> {
  try {
    await env.SCRAPE_CACHE.put(key, JSON.stringify(value), { expirationTtl: TTL });
  } catch {
    /* never block on cache failure */
  }
}
