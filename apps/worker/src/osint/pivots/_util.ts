// Shared helpers for individual pivots.

import type { Env } from "../../types";
import { fetchPage } from "../../scraper/fetcher";

export interface SimpleFetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
}

// Lightweight direct fetch (no tier escalation) tailored for OSINT probes.
// We deliberately skip the heavyweight scraper pipeline because most probes
// are JSON APIs or short profile HTML — full tier escalation is overkill.
//
// Honors a hard timeout via AbortController; bubbles network errors as
// { ok: false }. Caller is responsible for negative-cache writes.
// Per-host rate gate + ROLLING-WINDOW request meter shared across ALL pivots.
// Satisfies the Task 22 rate-limit + Task 2 budget constraints without
// requiring every pivot to thread through a context object: any call to
// simpleGet implicitly participates in the shared limiter.
//
// The budget is a 60s sliding window (not a monotonic counter) so warm
// isolates never reach permanent budget_exceeded — old timestamps age
// out naturally and steady-state request rate is capped at
// BUDGET_REQUESTS_CAP per 60s.
const HOST_LAST_HIT = new Map<string, number>();
const HOST_MIN_GAP_MS = 800;
const BUDGET_WINDOW_MS = 60_000;
const BUDGET_REQUESTS_CAP = 600;
const BUDGET_TS: number[] = [];

async function gateHost(url: string): Promise<void> {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  const last = HOST_LAST_HIT.get(host) ?? 0;
  const wait = HOST_MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  HOST_LAST_HIT.set(host, Date.now());
}

function budgetAdmit(): boolean {
  const now = Date.now();
  while (BUDGET_TS.length && now - BUDGET_TS[0] > BUDGET_WINDOW_MS) BUDGET_TS.shift();
  if (BUDGET_TS.length >= BUDGET_REQUESTS_CAP) return false;
  BUDGET_TS.push(now);
  return true;
}

export function resetOsintBudgetForTests(): void { BUDGET_TS.length = 0; HOST_LAST_HIT.clear(); }

export async function simpleGet(
  url: string,
  opts: { timeoutMs?: number; accept?: string; ua?: string } = {},
): Promise<SimpleFetchResult> {
  if (!budgetAdmit()) {
    return { ok: false, status: 0, text: "budget_exceeded", contentType: "" };
  }
  await gateHost(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": opts.ua ?? "AIDataSignal-OSINT/1.0 (+https://aidatasignal.com)",
        "Accept": opts.accept ?? "text/html,application/json;q=0.9,*/*;q=0.1",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") ?? "";
    let text = "";
    // Cap body at 256 KiB — profile pages are well under this.
    const reader = res.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); total += value.length; if (total > 262144) break; }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      text = new TextDecoder("utf-8").decode(merged);
    }
    return { ok: res.ok, status: res.status, text, contentType: ct };
  } catch (e) {
    return { ok: false, status: 0, text: (e as Error).message, contentType: "" };
  } finally {
    clearTimeout(t);
  }
}

// Concurrency-limited Promise.all.
export async function parallelMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Time gate — quick check before launching a sub-probe.
export function pastDeadline(deadlineMs: number): boolean {
  return Date.now() > deadlineMs;
}

// Tiered, rate-limited fetch via the existing scraper pipeline. Used by
// the username sweep where Task 5's tier-2 proxy + Task 22 per-host rate
// limiter are required so we don't burn the home IP on anti-bot platforms.
// Falls back to `simpleGet` if the scraper pipeline returns a non-OK block
// reason that isn't a real 404 (e.g. circuit_open).
export async function tieredGet(env: Env, url: string, opts: { timeoutMs?: number } = {}): Promise<SimpleFetchResult> {
  try {
    const r = await fetchPage(env, url, {
      minIntervalMs: 1500,
      timeoutMs: opts.timeoutMs ?? 3500,
      liveOnly: true,
    });
    if (r.ok && r.html) {
      const text = r.html.length > 262144 ? r.html.slice(0, 262144) : r.html;
      return { ok: true, status: r.status ?? 200, text, contentType: "text/html" };
    }
    if (r.status && r.status >= 400 && r.status < 500) {
      return { ok: false, status: r.status, text: r.html ?? "", contentType: "text/html" };
    }
    // Soft-block (circuit_open, robots, tos) — fall back so the OSINT
    // probe still gets a chance, but we burn through tier 0 only.
    return await simpleGet(url, opts);
  } catch {
    return await simpleGet(url, opts);
  }
}

// URL-keyed negative cache wrapper. Mandatory negative-cache policy:
// every pivot that probes an external resource should route through
// this helper. A previous 404/410/miss for the same URL short-circuits
// without spending budget or making the network call. Successful or
// transient (5xx, timeout) responses are NOT cached; only definite
// misses are recorded.
const URL_MISS_KV_PREFIX = "osint:miss:url";
function urlMissKey(url: string): string {
  // Trim querystring noise but preserve path so /user/X.json and
  // /user/Y.json don't collide.
  try {
    const u = new URL(url);
    return `${URL_MISS_KV_PREFIX}:${u.host}${u.pathname}${u.search}`;
  } catch { return `${URL_MISS_KV_PREFIX}:${url}`; }
}

export async function simpleGetCached(
  env: Env,
  url: string,
  opts: { timeoutMs?: number; accept?: string; ua?: string; ttlSeconds?: number; missHints?: string[] } = {},
): Promise<SimpleFetchResult> {
  const key = urlMissKey(url);
  try {
    const cached = await env.SCRAPE_CACHE?.get(key);
    if (cached) return { ok: false, status: 404, text: "negative_cache", contentType: "" };
  } catch { /* ignore */ }
  const res = await simpleGet(url, opts);
  const isDefiniteMiss =
    res.status === 404 || res.status === 410 ||
    (res.ok && !!opts.missHints && bodyLooksLikeMiss(res.text, opts.missHints));
  if (isDefiniteMiss) {
    try {
      await env.SCRAPE_CACHE?.put(key, "1", { expirationTtl: opts.ttlSeconds ?? 30 * 24 * 3600 });
    } catch { /* ignore */ }
  }
  return res;
}

// Best-effort log without throwing.
export function safeLog(label: string, info: Record<string, unknown>): void {
  try { console.log(`osint:${label}`, JSON.stringify(info)); } catch { /* ignore */ }
}

// True when a 200-OK body contains a known not-found marker.
export function bodyLooksLikeMiss(text: string, hints: string[]): boolean {
  if (!text || !hints.length) return false;
  const low = text.toLowerCase();
  return hints.some((h) => low.includes(h.toLowerCase()));
}

// Generate plausible handle candidates from a display name and known handles.
export function generateHandleVariants(facts: { displayName: string | null; emails: string[]; knownHandles: Array<{ handle: string }>; }): string[] {
  const out = new Set<string>();
  for (const h of facts.knownHandles) {
    if (h.handle) out.add(h.handle.toLowerCase());
  }
  if (facts.displayName) {
    const norm = facts.displayName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const parts = norm.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0].replace(/[^a-z0-9]/g, "");
      const last = parts[parts.length - 1].replace(/[^a-z0-9]/g, "");
      if (first && last) {
        out.add(`${first}${last}`);
        out.add(`${first}.${last}`);
        out.add(`${first}_${last}`);
        out.add(`${first}-${last}`);
        out.add(`${first[0]}${last}`);
        out.add(`${first}${last[0]}`);
      }
    } else if (parts[0]) {
      out.add(parts[0].replace(/[^a-z0-9]/g, ""));
    }
  }
  for (const email of facts.emails) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local) out.add(local.replace(/[^a-z0-9._-]/g, ""));
  }
  return [...out].filter((s) => s.length >= 2 && s.length <= 40);
}
