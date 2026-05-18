// Task #3: Operational drain — one nightly call per IntlAdapter.
//
// Iterates every registered IntlAdapter, pulls recent filings since the
// last successful drain (or a 7-day floor on first run), and routes
// each through persistIntlFiling. Per-adapter errors are isolated so
// one broken jurisdiction never blocks the rest.

import type { Env } from "../../types";
import { INTL_ADAPTERS } from "../../crawler/adapters/intl/registry";
import { persistIntlFiling } from "./persist";

export interface IntlDrainSummary {
  adapter_id: string;
  jurisdiction: string;
  filings_seen: number;
  filings_persisted: number;
  fx_errors: number;
  translated: number;
  error: string | null;
}

const KV_CURSOR_PREFIX = "intl:drain:since:";

async function readSince(env: Env, adapterId: string, defaultDaysBack: number): Promise<string> {
  if (env.SCRAPE_CACHE) {
    const cached = await env.SCRAPE_CACHE.get(`${KV_CURSOR_PREFIX}${adapterId}`);
    if (cached && /^\d{4}-\d{2}-\d{2}$/.test(cached)) return cached;
  }
  const d = new Date(Date.now() - defaultDaysBack * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function writeSince(env: Env, adapterId: string, dateIso: string): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  await env.SCRAPE_CACHE.put(`${KV_CURSOR_PREFIX}${adapterId}`, dateIso, { expirationTtl: 60 * 60 * 24 * 90 });
}

export async function drainAllIntlFilings(env: Env, opts: { defaultDaysBack?: number; perAdapterCap?: number } = {}): Promise<IntlDrainSummary[]> {
  const defaultDaysBack = opts.defaultDaysBack ?? 7;
  const cap = opts.perAdapterCap ?? 100;
  const out: IntlDrainSummary[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const adapter of INTL_ADAPTERS) {
    const summary: IntlDrainSummary = {
      adapter_id: adapter.id, jurisdiction: adapter.jurisdiction,
      filings_seen: 0, filings_persisted: 0, fx_errors: 0, translated: 0,
      error: null,
    };
    try {
      const since = await readSince(env, adapter.id, defaultDaysBack);
      const filings = await adapter.streamRecentFilings(env, since);
      summary.filings_seen = filings.length;
      for (const f of filings.slice(0, cap)) {
        try {
          const res = await persistIntlFiling(env, adapter, f);
          if (res.facts_written > 0) summary.filings_persisted += 1;
          if (res.fx_error) summary.fx_errors += 1;
          if (res.translated) summary.translated += 1;
        } catch (e) {
          console.warn("persistIntlFiling failed", adapter.id, f.source_id, (e as Error).message);
        }
      }
      await writeSince(env, adapter.id, today);
    } catch (e) {
      summary.error = (e as Error).message;
      console.warn("intl drain failed", adapter.id, summary.error);
    }
    out.push(summary);
  }
  return out;
}
