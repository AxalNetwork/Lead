// Task #2: link discovery orchestrator.
//
// `runDiscoverFromSeed(env, opts)` is the entry point for both the
// `DiscoverFromSeedWorkflow` and the synchronous `POST /api/discovery/seed`
// route. It fans out across the enabled methods, canonicalizes + predicts
// yield for every raw link, upserts into `discovered_urls`, edges into
// `link_graph`, and queues high-yield candidates into `crawl_frontier`.
//
// `runCrawlFrontier(env, opts)` pops up to N URLs and fetches each,
// then re-invokes runDiscoverFromSeed on the fetched HTML so discovery
// fans out recursively. Bounded by depth + per-host caps.

import type { Env } from "../types";
import { fetchPage } from "../scraper/fetcher";
import { canonicalizeUrl } from "./canonical";
import {
  ALL_METHOD_NAMES, methodOutbound, methodSitemap, methodRssAtom, methodOpengraph,
  methodJsonLdSameAs, methodWayback, methodSisterPages, methodCitations,
} from "./methods";
import { predictYield } from "./predictYield";
import {
  upsertDiscoveredUrl, insertLinkEdge, enqueueFrontier, popFrontier,
  markCrawled, markFrontierError, bumpRunHostCount, getRunHostCount,
} from "./store.discovery";
import { computePriority, assertHostPolite } from "./scheduler";

export interface SeedOpts {
  url: string;
  depth?: number;             // current depth (default 0)
  depthMax?: number;          // ceiling (default 3)
  maxPerHost?: number;        // run-wide host cap (default 200)
  methods?: string[];         // subset of ALL_METHOD_NAMES; default = all implemented
  runId?: string;             // discovery_runs row id; created if missing
  yieldThreshold?: number;    // min score to queue (default 0.35)
  jobId?: string | null;      // legacy linkage
  parentUrlId?: string | null;
  html?: string;              // pre-fetched body, avoids a second GET
}

export interface SeedResult {
  runId: string;
  discovered: number;
  queued: number;
  rejected: number;
  method_counts: Record<string, number>;
}

const IMPLEMENTED = new Set(["outbound", "sitemap", "rss_atom", "opengraph_meta", "jsonld_sameas", "archive_wayback", "sister_pages", "citations"]);

export async function runDiscoverFromSeed(env: Env, opts: SeedOpts): Promise<SeedResult> {
  const seedCanon = canonicalizeUrl(opts.url);
  if (!seedCanon) throw new Error("invalid_seed_url");
  const depth = opts.depth ?? 0;
  const depthMax = opts.depthMax ?? 3;
  const maxPerHost = opts.maxPerHost ?? 200;
  const yieldThreshold = opts.yieldThreshold ?? 0.35;
  const enabled = (opts.methods?.filter((m) => IMPLEMENTED.has(m)) ?? [...IMPLEMENTED]) as string[];

  // Create or look up the run row.
  const runId = opts.runId ?? crypto.randomUUID();
  if (!opts.runId) {
    await env.DB.prepare(
      `INSERT INTO discovery_runs (id, seed_url, seed_host, depth_max, max_per_host, methods_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(runId, seedCanon.url, seedCanon.host, depthMax, maxPerHost, JSON.stringify(enabled)).run();
  }

  // Insert the seed itself so edges have a parent.
  let parentUrlId = opts.parentUrlId ?? null;
  if (!parentUrlId) {
    const seedRow = await upsertDiscoveredUrl(env, {
      url: seedCanon.url,
      discoveryMethod: "seed",
      depth,
      expectedYieldScore: 1.0,
      status: "crawled",
      jobId: opts.jobId ?? null,
    });
    parentUrlId = seedRow?.id ?? null;
  }

  // Fetch the seed HTML once so HTML-dependent methods share it.
  let html: string | undefined = opts.html;
  if (!html && (enabled.includes("outbound") || enabled.includes("opengraph_meta") || enabled.includes("jsonld_sameas") || enabled.includes("rss_atom") || enabled.includes("sister_pages"))) {
    try {
      const f = await fetchPage(env, seedCanon.url);
      if (f.ok && f.html) html = f.html;
    } catch (e) {
      console.warn("seed fetch failed", (e as Error).message);
    }
  }

  // Fan out across the enabled methods in parallel.
  const methodFns: Record<string, () => Promise<{ url: string; link_text?: string | null; likely_kind?: string | null; method: string }[]>> = {
    outbound:       () => methodOutbound(env, seedCanon.url, html),
    sitemap:        () => methodSitemap(env, seedCanon.url),
    rss_atom:       () => methodRssAtom(env, seedCanon.url, html),
    opengraph_meta: () => methodOpengraph(env, seedCanon.url, html),
    jsonld_sameas:  () => methodJsonLdSameAs(env, seedCanon.url, html),
    archive_wayback:() => methodWayback(env, seedCanon.url),
    sister_pages:   () => methodSisterPages(env, seedCanon.url, html),
    citations:      () => methodCitations(env, seedCanon.url),
  };
  const settled = await Promise.allSettled(enabled.map(async (name) => ({ name, links: await methodFns[name]() })));

  // Run-wide host counter. Read the persisted base once per host then
  // amortize increments locally; flush back to the DB at the end so the
  // ceiling holds across recursive `runDiscoverFromSeed` calls AND
  // across `runCrawlFrontier` invocations sharing the same runId.
  const hostBase: Record<string, number> = {};
  const hostDelta: Record<string, number> = {};
  const ensureHostBase = async (host: string) => {
    if (hostBase[host] == null) hostBase[host] = await getRunHostCount(env, runId, host);
  };
  const method_counts: Record<string, number> = {};
  let discovered = 0, queued = 0, rejected = 0;

  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const { name, links } = s.value;
    method_counts[name] = (method_counts[name] ?? 0) + links.length;
    // Dedupe within this method's batch so duplicate links don't
    // consume per-host quota or double-count.
    const seenCanon = new Set<string>();
    for (const raw of links) {
      const c = canonicalizeUrl(raw.url);
      if (!c) continue;
      // Don't re-insert the seed itself.
      if (c.canonical === seedCanon.canonical) continue;
      if (seenCanon.has(c.canonical)) continue;
      seenCanon.add(c.canonical);
      // Run-wide per-host cap check (we increment *after* the upsert
      // succeeds, so duplicates / rejects don't consume the quota).
      await ensureHostBase(c.host);
      if (hostBase[c.host] + (hostDelta[c.host] ?? 0) >= maxPerHost) {
        // Lightweight freshness touch: if we already know this URL,
        // bump `last_seen` even though we won't re-process it. Keeps
        // freshness metrics honest when a host is at its run cap.
        await env.DB.prepare(
          `UPDATE discovered_urls SET last_seen = CURRENT_TIMESTAMP WHERE url_canonical = ?`,
        ).bind(c.canonical).run();
        rejected++; continue;
      }

      const verdict = await predictYield(env, { url: c.url, method: name, depth: depth + 1, link_text: raw.link_text });
      const row = await upsertDiscoveredUrl(env, {
        url: c.url,
        discoveredFromUrl: seedCanon.url,
        discoveredFromId: parentUrlId,
        discoveryMethod: name,
        depth: depth + 1,
        linkText: raw.link_text ?? null,
        likelyKind: raw.likely_kind ?? verdict.predicted_kind,
        expectedYieldScore: verdict.yield_score,
        jobId: opts.jobId ?? null,
      });
      if (!row) continue;
      if (row.created) {
        discovered++;
        // Only count the host quota on a brand-new accepted URL. Dupes
        // and rejects are free.
        if (!row.rejected) hostDelta[c.host] = (hostDelta[c.host] ?? 0) + 1;
      }
      if (parentUrlId) await insertLinkEdge(env, parentUrlId, row.id, name, verdict.yield_score);
      if (!row.rejected && verdict.yield_score >= yieldThreshold && (depth + 1) <= depthMax) {
        const prio = computePriority({
          yield_score: verdict.yield_score,
          depth: depth + 1,
          host: c.host,
          host_fetch_count_in_run: hostBase[c.host] + hostDelta[c.host],
          max_per_host: maxPerHost,
        });
        await enqueueFrontier(env, row.id, prio, runId);
        queued++;
      } else if (row.rejected) {
        rejected++;
      }
    }
  }

  // Flush per-host deltas in a single batch so the next recursive call
  // (or the frontier-crawl follow-up) sees the up-to-date totals.
  const deltaEntries = Object.entries(hostDelta).filter(([, n]) => n > 0);
  if (deltaEntries.length) {
    await Promise.all(deltaEntries.map(([host, n]) => bumpRunHostCount(env, runId, host, n)));
  }

  // Update the run row aggregates.
  await env.DB.prepare(
    `UPDATE discovery_runs SET
       discovered = discovered + ?,
       queued = queued + ?,
       status = 'running'
     WHERE id = ?`,
  ).bind(discovered, queued, runId).run();

  return { runId, discovered, queued, rejected, method_counts };
}

export interface FrontierOpts {
  runId?: string;
  limit?: number;
  depthMax?: number;
  maxPerHost?: number;
  yieldThreshold?: number;
}

export async function runCrawlFrontier(env: Env, opts: FrontierOpts = {}): Promise<{ scanned: number; fetched: number; recursed: number; entities: number; errors: number }> {
  const limit = opts.limit ?? 25;
  const items = await popFrontier(env, limit, opts.runId ?? null);
  let fetched = 0, recursed = 0, entities = 0, errors = 0;
  // Per-run accumulators so progress is attributed correctly even when
  // the caller doesn't pin opts.runId (e.g. a cron crawl that drains
  // a mixed-run frontier).
  const perRunFetched: Record<string, number> = {};
  const perRunEntities: Record<string, number> = {};

  for (const it of items) {
    if (!(await assertHostPolite(env, it.host))) {
      // Skip — leave on the frontier with a future re-attempt window.
      await markFrontierError(env, it.url_id, "host_rate_limited");
      continue;
    }
    try {
      const f = await fetchPage(env, it.url);
      if (!f.ok || !f.html) {
        errors++;
        await markFrontierError(env, it.url_id, `fetch_${f.status ?? "fail"}`);
        continue;
      }
      fetched++;
      const attribRun = opts.runId ?? it.run_id ?? null;
      if (attribRun) perRunFetched[attribRun] = (perRunFetched[attribRun] ?? 0) + 1;
      // 1. Extraction: feed the fetched page through the existing
      //    extractor so discovered profile pages actually produce
      //    entities. We collect the inserted lead IDs and pass them
      //    into `markCrawled` so the URL row records its harvest.
      let entityIds: string[] = [];
      try {
        const { extractFromHtml } = await import("./extractAdapter");
        entityIds = await extractFromHtml(env, it.url, f.html);
      } catch (e) {
        console.warn("discovery_extract_failed", (e as Error).message);
      }
      entities += entityIds.length;
      if (attribRun && entityIds.length) perRunEntities[attribRun] = (perRunEntities[attribRun] ?? 0) + entityIds.length;
      // 2. Recursion: discover further links from this page.
      const r = await runDiscoverFromSeed(env, {
        url: it.url,
        depth: it.depth,
        depthMax: opts.depthMax ?? 3,
        maxPerHost: opts.maxPerHost ?? 200,
        yieldThreshold: opts.yieldThreshold ?? 0.4,
        runId: opts.runId ?? it.run_id ?? undefined,
        parentUrlId: it.url_id,
        html: f.html,
      });
      recursed += r.discovered;
      await markCrawled(env, it.url_id, entityIds);
    } catch (e) {
      errors++;
      await markFrontierError(env, it.url_id, (e as Error).message.slice(0, 200));
    }
  }

  // 3. Live run progress. Update each run's counters by attributed
  //    (claimed-row) run_id so stats stay accurate whether the caller
  //    pinned opts.runId or popped a mixed-run batch.
  const touchedRuns = new Set<string>([...Object.keys(perRunFetched), ...Object.keys(perRunEntities)]);
  for (const rid of touchedRuns) {
    await env.DB.prepare(
      `UPDATE discovery_runs
          SET crawled = crawled + ?,
              entities_found = entities_found + ?
        WHERE id = ?`,
    ).bind(perRunFetched[rid] ?? 0, perRunEntities[rid] ?? 0, rid).run();
  }

  return { scanned: items.length, fetched, recursed, entities, errors };
}

export { ALL_METHOD_NAMES };
