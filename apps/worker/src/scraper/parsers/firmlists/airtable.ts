import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import { extractDomain, countryNameToIso2 } from "../../normalize";
import { classifyTab } from "../../../imports/tab_intent";
import { classifyUrl, extractUrlsFromRows } from "../../../imports/url_extract";
import type {
  EdgeCandidate,
  FirmlistImportResult,
  KeyedFirmCandidate,
  KeyedPersonCandidate,
} from "./types";
import { parseUsdRange } from "./_helpers";

/**
 * Airtable shared-view + Universe importer v2 (Task #2).
 *
 * Three URL variants:
 *   A) `airtable.com/{appId}/{shrId}` (+ optional `/{tblId}` and/or `/{viwId}`)
 *      → single shared view. Open via Browser Rendering, intercept
 *        `readSharedViewData` / `readSharedRowsAndColumns` XHRs.
 *   B) `airtable.com/{appId}/{shrId}` with no `tbl`/`viw` segment
 *      → multi-table shared base. Enumerate tables from the bootstrap
 *        and fan out to Variant A per table.
 *   C) `airtable.com/universe/{expId}/{slug}?explore=true`
 *      → Universe explore. Parse `__INITIAL_DATA__`, extract the
 *        embedded sharedBase URL, dispatch to Variant B, and tag every
 *        entity with `collection:explore.{slug}`.
 *
 * Output: typed FirmlistImportResult with firms[], people[], edges[],
 * childUrls[] (URLs lifted from text cells), sourceCollection (Universe
 * pages only), and tableTabs[] (per-table intent for shared bases).
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const parsed = parseAirtableUrl(url);
  if (!parsed) {
    return { firms: [], totalSeen: 0, errors: [`airtable_url_invalid:${url}`] };
  }

  if (parsed.variant === "universe") {
    return importUniverse(env, url, parsed);
  }
  return dispatchShare(env, url, parsed);
}

/**
 * Deterministic dispatch for `airtable.com/{appId}/{shrId}[/...]` links.
 *
 * URL shape alone cannot reliably distinguish a single-table shared
 * view from a multi-table shared base — many real shared bases pin at
 * the bare `app/shr` form, and many shared views do too. So we probe
 * the `readSharedBase` metadata endpoint first: if it reports ≥2
 * tables (and no explicit tableId/viewId is pinned in the URL), the
 * share is treated as a base and fanned out via `importBase`.
 * Otherwise — including any case where the probe fails or returns a
 * single table — we route through `importView`.
 */
async function dispatchShare(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
  opts?: { collection?: string | null; seedHints?: SeedHints | null },
): Promise<FirmlistImportResult> {
  const ctx: ImportContext | undefined = opts
    ? { collection: opts.collection ?? null, seedHints: opts.seedHints ?? null }
    : undefined;
  if (parsed.tableId || parsed.viewId) {
    return importView(env, url, parsed, ctx);
  }
  let tables: Array<{ id: string; name: string; defaultViewId: string | null }> = [];
  try {
    tables = await fetchSharedBaseTables(parsed);
  } catch { tables = []; }
  if (tables.length >= 2) {
    return importBase(env, url, { ...parsed, variant: "base" }, ctx);
  }
  return importView(env, url, parsed, ctx);
}

// ============================================================================
// URL parsing
// ============================================================================

interface ParsedAirtableUrl {
  variant: "view" | "base" | "universe";
  appId: string | null;
  shareId: string | null;
  tableId: string | null;
  viewId: string | null;
  expId: string | null;
  slug: string | null;
}

export function parseAirtableUrl(url: string): ParsedAirtableUrl | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname.toLowerCase() !== "airtable.com") return null;
  const path = u.pathname.replace(/^\/+/, "");

  // Variant C: Universe explore page.
  const univMatch = path.match(/^universe\/(exp[A-Za-z0-9]+)(?:\/([^/?#]+))?/i);
  if (univMatch) {
    return {
      variant: "universe",
      appId: null, shareId: null, tableId: null, viewId: null,
      expId: univMatch[1],
      slug: univMatch[2] ?? null,
    };
  }

  // Variants A / B: appId / shrId / [tblId] / [viwId].
  const segs = path.split("/").filter(Boolean);
  const appId = segs.find((s) => /^app[A-Za-z0-9]{10,}$/.test(s)) ?? null;
  const shareId = segs.find((s) => /^shr[A-Za-z0-9]{10,}$/.test(s)) ?? null;
  const tableId = segs.find((s) => /^tbl[A-Za-z0-9]{10,}$/.test(s)) ?? null;
  const viewId = segs.find((s) => /^viw[A-Za-z0-9]{10,}$/.test(s)) ?? null;
  if (!shareId) return null;
  // URL-shape alone cannot reliably distinguish a single-table shared
  // view from a multi-table shared base: many real views are pinned at
  // the bare `app.../shr...` form. We default to "view" (cheap path —
  // readSharedViewData succeeds on either shape and returns the first
  // table) and let `importView` fall back to base enumeration if the
  // view-scoped endpoint reports a multi-table base. `tableId`/`viewId`
  // when present override the heuristic and force the view path.
  return {
    variant: "view",
    appId, shareId, tableId, viewId, expId: null, slug: null,
  };
}

// ============================================================================
// Variant A: single shared view
// ============================================================================

interface AirtableColumn {
  id: string;
  name: string;
  type: string;
  typeOptions?: Record<string, unknown>;
  /** Foreign-table id for multipleRecordLinks columns. */
  foreignTableId?: string;
}

interface AirtableRow {
  id: string;
  cellValuesByColumnId?: Record<string, unknown>;
  /** Alternate shape used by some payload versions. */
  cellsByColumnId?: Record<string, unknown>;
}

interface AirtableTablePayload {
  id: string;
  name?: string;
  columns: AirtableColumn[];
  rows: AirtableRow[];
  /** For multipleRecordLinks: maps foreign tableId → {rows[{id,primary}], columns}. */
  foreignTables?: Record<string, { rows?: Array<{ id: string; primary?: string }>; columns?: AirtableColumn[] }>;
}

interface ImportContext {
  collection: string | null;
  /** Pre-seeded source-level hints (role/country/region). */
  seedHints: SeedHints | null;
}

async function importView(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
  ctx?: ImportContext,
): Promise<FirmlistImportResult> {
  const errors: string[] = [];
  const seedHints = ctx?.seedHints ?? lookupSeedHints(url);
  const collection = ctx?.collection ?? null;

  // Phase A: Browser Rendering — intercept readSharedViewData XHRs.
  const harvest = await browserHarvestView(env, url, parsed, errors);
  let table: AirtableTablePayload | null = harvest.table;

  // Phase A fallback: direct API call (works when the share is public
  // and Airtable hasn't rotated the endpoint).
  if (!table || !table.rows.length) {
    try {
      const apiTable = await fetchReadSharedViewData(parsed);
      if (apiTable?.rows.length) table = apiTable;
    } catch (e) {
      errors.push(`api_fetch:${(e as Error).message}`);
    }
  }

  // Phase B: schema cache fallback.
  if ((!table || !table.columns.length) && parsed.shareId) {
    const cached = await loadSchemaCache(env, parsed.shareId, parsed.tableId ?? parsed.shareId).catch(() => null);
    if (cached) {
      if (!table) table = { id: parsed.tableId ?? parsed.shareId, columns: cached, rows: [] };
      else table.columns = cached;
      errors.push("schema_from_cache");
    }
  }

  // Phase C: DOM scrape from the rendered HTML.
  if ((!table || !table.rows.length) && harvest.html) {
    const dom = scrapeDomRows(harvest.html, table?.columns ?? []);
    if (dom.rows.length) {
      table = table ?? { id: parsed.tableId ?? parsed.shareId ?? "", columns: dom.columns, rows: [] };
      if (!table.columns.length) table.columns = dom.columns;
      table.rows = dom.rows;
    }
  }

  if (!table || !table.rows.length) {
    return { firms: [], totalSeen: 0, errors: errors.length ? errors : ["no_rows"] };
  }

  // Persist schema (best-effort).
  if (parsed.shareId && table.columns.length) {
    await saveSchemaCache(env, parsed.shareId, table.id ?? parsed.tableId ?? parsed.shareId, table.columns, collection)
      .catch(() => undefined);
  }

  return assembleResult(table, url, seedHints, collection, errors);
}

// ============================================================================
// Variant B: shared base (multi-table)
// ============================================================================

async function importBase(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
  ctx?: ImportContext,
): Promise<FirmlistImportResult> {
  const errors: string[] = [];
  const seedHints = ctx?.seedHints ?? lookupSeedHints(url);
  const collection = ctx?.collection ?? null;

  // Enumerate tables from the base bootstrap.
  let tableList: Array<{ id: string; name: string; defaultViewId: string | null }> = [];
  try {
    tableList = await fetchSharedBaseTables(parsed);
  } catch (e) {
    errors.push(`base_enum:${(e as Error).message}`);
  }

  if (!tableList.length) {
    // Fallback: open in browser and read window data.
    const harvest = await browserHarvestBase(env, url, parsed, errors);
    tableList = harvest.tables;
  }

  if (!tableList.length) {
    return { firms: [], totalSeen: 0, errors: errors.length ? errors : ["base_no_tables"] };
  }

  const merged: FirmlistImportResult = {
    firms: [], people: [], edges: [], childUrls: [], stubEntities: [],
    totalSeen: 0, errors: [], tableTabs: [], sourceCollection: collection,
  };

  for (const t of tableList) {
    const viewParsed: ParsedAirtableUrl = { ...parsed, variant: "view", tableId: t.id, viewId: t.defaultViewId };
    const viewUrl = `https://airtable.com/${parsed.appId ?? ""}/${parsed.shareId}/${t.id}` +
      (t.defaultViewId ? `/${t.defaultViewId}` : "");
    const sub = await importView(env, viewUrl, viewParsed, { collection, seedHints });
    merged.totalSeen += sub.totalSeen;
    merged.firms.push(...sub.firms);
    if (sub.people) (merged.people ??= []).push(...sub.people);
    if (sub.edges) (merged.edges ??= []).push(...sub.edges);
    if (sub.childUrls) (merged.childUrls ??= []).push(...sub.childUrls);
    if (sub.stubEntities) (merged.stubEntities ??= []).push(...sub.stubEntities);
    if (sub.errors) (merged.errors ??= []).push(...sub.errors.map((e) => `${t.id}:${e}`));
    const intent = classifyTab(t.name, []);
    (merged.tableTabs ??= []).push({
      tableId: t.id,
      name: t.name,
      intent: intent.intent,
      rowCount: sub.totalSeen,
    });
  }

  if (errors.length) (merged.errors ??= []).push(...errors);
  return merged;
}

// ============================================================================
// Variant C: Universe explore page
// ============================================================================

async function importUniverse(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
): Promise<FirmlistImportResult> {
  const errors: string[] = [];
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`universe_fetch:${fetched.blockReason ?? "unknown"}`] };
  }
  const initial = extractInitialData(fetched.html);
  const baseHref = findUniverseBaseLink(initial, fetched.html);
  if (!baseHref) {
    return { firms: [], totalSeen: 0, errors: ["universe_no_base_link"] };
  }
  const baseParsed = parseAirtableUrl(baseHref);
  if (!baseParsed) {
    return { firms: [], totalSeen: 0, errors: [`universe_bad_base:${baseHref}`] };
  }
  const slug = parsed.slug ?? "unknown";
  const collection = `explore.${slug}`;
  const seedHints = lookupSeedHints(url);

  // Capture Universe marketing context (title, description, categories,
  // author) so re-imports can re-tag entities and the dashboard can
  // surface the explore page provenance without re-fetching the HTML.
  const universeContext = extractUniverseContext(initial, fetched.html);

  // Re-use the same deterministic probe used for plain share links so
  // Universe → embedded sharedBase always lands in the right variant
  // (parser heuristics never decide). Multi-table bases fan out; a
  // single-table base/view routes through importView.
  const sub = await dispatchShare(env, baseHref, baseParsed, { collection, seedHints });

  sub.sourceCollection = collection;
  // Persist the marketing context on the schema-cache row keyed by
  // (shareId, '__universe'). Read by Task #6 / dashboard imports view.
  if (baseParsed.shareId) {
    await saveUniverseContext(env, baseParsed.shareId, {
      slug,
      collection,
      explore_url: url,
      shared_base_url: baseHref,
      ...universeContext,
    }).catch(() => undefined);
  }
  if (errors.length) (sub.errors ??= []).push(...errors);
  return sub;
}

interface UniverseContext {
  title: string | null;
  description: string | null;
  categories: string[];
  author: string | null;
}

function extractUniverseContext(initial: unknown, html: string): UniverseContext {
  let title: string | null = null;
  let description: string | null = null;
  let author: string | null = null;
  const categories = new Set<string>();
  // 1. Walk __INITIAL_DATA__ for the standard Universe payload shape.
  walk(initial, (v) => {
    if (!isObj(v)) return;
    const o = v as Record<string, unknown>;
    if (!title && typeof o.title === "string" && o.title.length > 3 && o.title.length < 200) {
      title = o.title;
    }
    if (!description && typeof o.description === "string" && o.description.length > 10) {
      description = o.description;
    }
    if (!author && typeof o.authorName === "string") author = o.authorName;
    if (!author && isObj(o.author) && typeof (o.author as Record<string, unknown>).name === "string") {
      author = String((o.author as Record<string, unknown>).name);
    }
    if (Array.isArray(o.categories)) {
      for (const c of o.categories) {
        if (typeof c === "string") categories.add(c);
        else if (isObj(c) && typeof (c as Record<string, unknown>).name === "string") {
          categories.add(String((c as Record<string, unknown>).name));
        }
      }
    }
  });
  // 2. Fallback: og: meta tags from the rendered HTML.
  if (!title) {
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) title = decodeEntities(m[1]);
  }
  if (!description) {
    const m = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']+)["']/i);
    if (m) description = decodeEntities(m[1]);
  }
  return { title, description, author, categories: [...categories] };
}

async function saveUniverseContext(
  env: Env,
  shareId: string,
  context: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO airtable_share_schema_cache (share_id, table_id, schema_json, context_json, fetched_at)
     VALUES (?, '__universe', '[]', ?, ?)
     ON CONFLICT(share_id, table_id) DO UPDATE SET
       context_json = excluded.context_json,
       fetched_at   = excluded.fetched_at`,
  ).bind(shareId, JSON.stringify(context), now).run();
}

function findUniverseBaseLink(initial: unknown, html: string): string | null {
  // 1. Walk __INITIAL_DATA__ for a sharedBase / shareUrl pointing at airtable.com/shr.
  const fromInitial = deepFindString(initial, (s) => /https?:\/\/airtable\.com\/app[A-Za-z0-9]+\/shr[A-Za-z0-9]+/i.test(s));
  if (fromInitial) {
    const m = fromInitial.match(/https?:\/\/airtable\.com\/app[A-Za-z0-9]+\/shr[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)*/i);
    if (m) return m[0];
  }
  // 2. Fall back to scanning the raw HTML for the share link.
  const m2 = html.match(/https?:\/\/airtable\.com\/app[A-Za-z0-9]+\/shr[A-Za-z0-9]+(?:\/(?:tbl|viw)[A-Za-z0-9]+)*/i);
  return m2 ? m2[0] : null;
}

// ============================================================================
// Browser Rendering: XHR interception for /readSharedViewData
// ============================================================================

interface PuppeteerResponse {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
}
interface PuppeteerPage {
  setUserAgent(ua: string): Promise<void>;
  setExtraHTTPHeaders(h: Record<string, string>): Promise<void>;
  setViewport(v: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  on(event: "response", cb: (r: PuppeteerResponse) => void): void;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}
interface PuppeteerBrowser { newPage(): Promise<PuppeteerPage>; close(): Promise<void> }

interface ViewHarvest { table: AirtableTablePayload | null; html: string }

async function browserHarvestView(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
  errors: string[],
): Promise<ViewHarvest> {
  if (!env.BROWSER) { errors.push("no_browser_binding"); return { table: null, html: "" }; }
  const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
    | { launch: (b: unknown) => Promise<PuppeteerBrowser> } | null;
  if (!mod) { errors.push("puppeteer_missing"); return { table: null, html: "" }; }

  const browser = await mod.launch(env.BROWSER);
  const captured: AirtableTablePayload[] = [];
  const pending: Promise<void>[] = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1440, height: 900 });

    const apiRe = /\/(?:readSharedViewData|readSharedRowsAndColumns|readSharedPage)\b/i;
    page.on("response", (resp) => {
      const u = resp.url();
      if (!apiRe.test(u)) return;
      const p = resp.json().then((body) => {
        const t = extractTablePayload(body);
        if (t) captured.push(t);
      }).catch(() => undefined);
      pending.push(p);
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: 45_000 });

    // Auto-scroll grid to force pagination and render every row.
    await page.evaluate(async () => {
      const g = globalThis as unknown as {
        document: { scrollingElement: unknown; body: { scrollHeight: number }; querySelectorAll: (s: string) => unknown };
        window: { scrollTo: (x: number, y: number) => void };
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const all = (g.document.querySelectorAll(".dataRowsContainer, [role='grid'], main, body") as unknown as { length: number; [i: number]: unknown }) ?? { length: 0 };
      const els: Array<{ scrollTop: number; scrollHeight: number }> = [];
      for (let i = 0; i < all.length; i++) els.push(all[i] as { scrollTop: number; scrollHeight: number });
      if (g.document.scrollingElement) els.push(g.document.scrollingElement as { scrollTop: number; scrollHeight: number });
      let lastH = -1;
      for (let i = 0; i < 50; i++) {
        for (const el of els) { try { el.scrollTop = el.scrollHeight; } catch { /* ignore */ } }
        try { g.window.scrollTo(0, g.document.body.scrollHeight); } catch { /* ignore */ }
        await sleep(700);
        const h = g.document.body.scrollHeight;
        if (h === lastH) break;
        lastH = h;
      }
      await sleep(800);
    });

    await Promise.all(pending);
    const html = await page.content().catch(() => "");
    // Merge captured payloads: same table id → union rows; otherwise pick the
    // one matching parsed.tableId, else the largest.
    const merged = mergePayloads(captured, parsed.tableId ?? null);
    return { table: merged, html };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function mergePayloads(batches: AirtableTablePayload[], preferTableId: string | null): AirtableTablePayload | null {
  if (!batches.length) return null;
  const wanted = preferTableId ? batches.filter((b) => b.id === preferTableId) : batches;
  const pool = wanted.length ? wanted : batches;
  // Union rows for the largest table.
  const byId = new Map<string, AirtableTablePayload>();
  for (const b of pool) {
    const prev = byId.get(b.id);
    if (!prev) { byId.set(b.id, { ...b, rows: [...b.rows] }); continue; }
    const seen = new Set(prev.rows.map((r) => r.id));
    for (const r of b.rows) if (!seen.has(r.id)) { prev.rows.push(r); seen.add(r.id); }
    if (!prev.columns.length && b.columns.length) prev.columns = b.columns;
    if (!prev.foreignTables && b.foreignTables) prev.foreignTables = b.foreignTables;
  }
  let best: AirtableTablePayload | null = null;
  for (const v of byId.values()) if (!best || v.rows.length > best.rows.length) best = v;
  return best;
}

/**
 * Walk a heterogeneous readSharedViewData payload and surface the
 * `{table:{id,columns,rows,foreignTables?}}` shape. Airtable wraps the
 * useful bits under `data.table` on most shares; some older shares ship
 * the shape directly at the top level.
 */
function extractTablePayload(body: unknown): AirtableTablePayload | null {
  let found: AirtableTablePayload | null = null;
  walk(body, (v) => {
    if (found) return;
    if (!isObj(v)) return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows)
        && (typeof o.id === "string" || (o.columns as unknown[]).every((c) => isObj(c) && typeof (c as { id?: unknown }).id === "string"))) {
      // Normalize columns: lift `typeOptions.foreignTableId` (and a few
      // legacy aliases) onto the top-level `foreignTableId` field so the
      // edge-builder can construct cross-table `to_key`s without
      // re-walking `typeOptions` per row.
      const cols = (o.columns as Array<Record<string, unknown>>)
        .filter((c) => isObj(c) && typeof c.id === "string")
        .map((c) => {
          const to = isObj(c.typeOptions) ? (c.typeOptions as Record<string, unknown>) : {};
          const foreignTableId =
            typeof c.foreignTableId === "string" ? c.foreignTableId :
            typeof to.foreignTableId === "string" ? (to.foreignTableId as string) :
            typeof to.relationColumnId === "string" && typeof to.linkedTableId === "string" ? (to.linkedTableId as string) :
            typeof to.linkedTableId === "string" ? (to.linkedTableId as string) :
            undefined;
          return {
            id: c.id as string,
            name: typeof c.name === "string" ? c.name : (c.id as string),
            type: typeof c.type === "string" ? c.type : "text",
            typeOptions: to,
            foreignTableId,
          } as AirtableColumn;
        });
      found = {
        id: typeof o.id === "string" ? o.id : "",
        name: typeof o.name === "string" ? o.name : undefined,
        columns: cols,
        rows: (o.rows as AirtableRow[]).filter((r) => isObj(r) && typeof r.id === "string"),
        foreignTables: isObj(o.foreignTables) ? (o.foreignTables as AirtableTablePayload["foreignTables"]) : undefined,
      };
    }
  });
  return found;
}

// ----------------------------------------------------------------------------
// Direct API call (no browser) — fast path for fully public shares.
// ----------------------------------------------------------------------------

async function fetchReadSharedViewData(parsed: ParsedAirtableUrl): Promise<AirtableTablePayload | null> {
  if (!parsed.shareId) return null;
  const stringParams = encodeURIComponent("{}");
  const requestId = Math.random().toString(36).slice(2);
  const accessPolicy = encodeURIComponent("{}");
  // Use the view-scoped endpoint when we have a viewId, otherwise the
  // share-scoped endpoint (which returns the first view of the share).
  const subject = parsed.viewId ?? parsed.shareId;
  const endpoint = `https://airtable.com/v0.3/view/${subject}/readSharedViewData?stringifiedObjectParams=${stringParams}&requestId=${requestId}&accessPolicy=${accessPolicy}`;
  const res = await fetch(endpoint, {
    headers: {
      "x-airtable-application-id": parsed.appId ?? "",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 AIDataSignal/2.0",
    },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body ? extractTablePayload(body) : null;
}

// ----------------------------------------------------------------------------
// Shared-base table enumeration (Variant B).
// ----------------------------------------------------------------------------

async function fetchSharedBaseTables(parsed: ParsedAirtableUrl): Promise<Array<{ id: string; name: string; defaultViewId: string | null }>> {
  if (!parsed.shareId) return [];
  const url = `https://airtable.com/v0.3/sharedBase/${parsed.shareId}/readSharedBase?accessPolicy=%7B%7D`;
  const res = await fetch(url, {
    headers: { "x-airtable-application-id": parsed.appId ?? "", Accept: "application/json" },
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null);
  const out: Array<{ id: string; name: string; defaultViewId: string | null }> = [];
  walk(body, (v) => {
    if (!isObj(v)) return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && /^tbl[A-Za-z0-9]+/.test(o.id) && typeof o.name === "string") {
      const views = Array.isArray(o.views) ? (o.views as Array<Record<string, unknown>>) : [];
      const defaultView = views.find((vw) => typeof vw.id === "string" && /^viw/.test(String(vw.id)));
      out.push({
        id: o.id,
        name: String(o.name),
        defaultViewId: defaultView ? String(defaultView.id) : null,
      });
    }
  });
  // Dedupe by id.
  const byId = new Map<string, { id: string; name: string; defaultViewId: string | null }>();
  for (const t of out) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
}

async function browserHarvestBase(
  env: Env,
  url: string,
  parsed: ParsedAirtableUrl,
  errors: string[],
): Promise<{ tables: Array<{ id: string; name: string; defaultViewId: string | null }> }> {
  if (!env.BROWSER) { errors.push("base_no_browser"); return { tables: [] }; }
  const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
    | { launch: (b: unknown) => Promise<PuppeteerBrowser> } | null;
  if (!mod) return { tables: [] };
  const browser = await mod.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 45_000 });
    const html = await page.content().catch(() => "");
    void parsed;
    const out: Array<{ id: string; name: string; defaultViewId: string | null }> = [];
    // Try __INITIAL_DATA__ first.
    const initial = extractInitialData(html);
    walk(initial, (v) => {
      if (!isObj(v)) return;
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && /^tbl[A-Za-z0-9]+/.test(o.id) && typeof o.name === "string") {
        out.push({ id: o.id, name: String(o.name), defaultViewId: null });
      }
    });
    const byId = new Map<string, { id: string; name: string; defaultViewId: string | null }>();
    for (const t of out) if (!byId.has(t.id)) byId.set(t.id, t);
    return { tables: [...byId.values()] };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ============================================================================
// DOM-scrape fallback
// ============================================================================

function scrapeDomRows(html: string, fallbackCols: AirtableColumn[]): { columns: AirtableColumn[]; rows: AirtableRow[] } {
  const rows: AirtableRow[] = [];
  const colIds = new Set<string>();
  // Match `<...data-rowid|data-row-key="rec...">...</...>`
  const rowRe = /data-(?:rowid|row-key)=["']([^"']+)["'][^>]*>([\s\S]*?)(?=data-(?:rowid|row-key)=|<\/section|<\/main|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2];
    const cells: Record<string, string> = {};
    const cellRe = /data-columnid=["']([^"']+)["'][^>]*>([\s\S]*?)</gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(inner)) !== null) {
      const cid = cm[1];
      colIds.add(cid);
      cells[cid] = decodeEntities(cm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    }
    if (Object.keys(cells).length) rows.push({ id, cellValuesByColumnId: cells });
  }
  const cols: AirtableColumn[] = fallbackCols.length
    ? fallbackCols
    : [...colIds].map((id) => ({ id, name: id, type: "text" }));
  return { columns: cols, rows };
}

// ============================================================================
// Cell-type extraction
// ============================================================================

/**
 * Reduce any Airtable cell value to a flat string + optional structured
 * payload (e.g. multipleRecordLinks → linked record ids).
 */
interface ExtractedCell {
  text: string;
  /** Linked-record ids for multipleRecordLinks cells. */
  links?: string[];
  /** URLs detected inside the cell (free-text or `url` field). */
  urls?: string[];
}

function extractCell(col: AirtableColumn, raw: unknown): ExtractedCell {
  if (raw == null) return { text: "" };
  const type = (col.type || "").toLowerCase();

  switch (type) {
    case "text":
    case "singlelinetext":
    case "multilinetext":
    case "richtext": {
      const s = String(raw).trim();
      return { text: s, urls: pickUrls(s) };
    }
    case "url":
      return { text: String(raw).trim(), urls: pickUrls(String(raw)) };
    case "email":
      return { text: String(raw).trim() };
    case "phone":
    case "phonenumber":
      return { text: String(raw).trim() };
    case "checkbox":
      return { text: raw ? "true" : "false" };
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "count":
      return { text: typeof raw === "number" ? String(raw) : String(raw).trim() };
    case "date":
    case "datetime":
      return { text: String(raw).trim() };
    case "barcode":
      if (isObj(raw)) {
        const o = raw as Record<string, unknown>;
        return { text: typeof o.text === "string" ? o.text : "" };
      }
      return { text: String(raw) };
    case "button":
      if (isObj(raw)) {
        const o = raw as Record<string, unknown>;
        return { text: typeof o.label === "string" ? o.label : "", urls: typeof o.url === "string" ? [o.url] : undefined };
      }
      return { text: "" };
    case "singleselect": {
      if (isObj(raw)) {
        const o = raw as Record<string, unknown>;
        return { text: typeof o.name === "string" ? o.name : String(raw) };
      }
      return { text: String(raw).trim() };
    }
    case "multipleselects": {
      if (Array.isArray(raw)) {
        const parts = raw.map((v) => isObj(v) ? (v as { name?: string }).name ?? "" : String(v)).filter(Boolean);
        return { text: parts.join(", ") };
      }
      return { text: String(raw) };
    }
    case "multipleattachments": {
      if (Array.isArray(raw)) {
        const urls = raw.map((a) => isObj(a) ? (a as { url?: string }).url : null).filter((u): u is string => Boolean(u));
        return { text: urls.join(", "), urls };
      }
      return { text: "" };
    }
    case "user":
    case "createdby":
    case "lastmodifiedby":
    case "multiplecollaborators": {
      const list = Array.isArray(raw) ? raw : [raw];
      const parts = list.map((u) => {
        if (isObj(u)) {
          const o = u as { name?: string; email?: string };
          return o.name ?? o.email ?? "";
        }
        return String(u);
      }).filter(Boolean);
      return { text: parts.join(", ") };
    }
    case "formula":
    case "rollup":
    case "lookup": {
      if (Array.isArray(raw)) {
        const parts = raw.map((x) => extractCell({ ...col, type: "text" }, x).text).filter(Boolean);
        return { text: parts.join(", ") };
      }
      if (isObj(raw)) {
        const o = raw as Record<string, unknown>;
        if (typeof o.value === "string") return { text: o.value, urls: pickUrls(o.value) };
        if (typeof o.value === "number") return { text: String(o.value) };
      }
      const s = String(raw).trim();
      return { text: s, urls: pickUrls(s) };
    }
    case "multiplerecordlinks":
    case "foreignkey": {
      // The raw value is an array of linked-record ids; resolution happens
      // at the edge-building step using `foreignTables`.
      const ids: string[] = [];
      if (Array.isArray(raw)) {
        for (const v of raw) {
          if (typeof v === "string" && /^rec[A-Za-z0-9]+/.test(v)) ids.push(v);
          else if (isObj(v) && typeof (v as { id?: unknown }).id === "string") ids.push(String((v as { id: string }).id));
        }
      }
      return { text: "", links: ids };
    }
    case "autonumber":
    case "createdtime":
    case "lastmodifiedtime":
      return { text: String(raw).trim() };
    default: {
      // Generic fallback for unknown future types: stringify defensively.
      if (Array.isArray(raw)) {
        return { text: raw.map((x) => coerceAny(x)).filter(Boolean).join(", ") };
      }
      return { text: coerceAny(raw) };
    }
  }
}

function coerceAny(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.value === "string") return o.value;
    if (typeof o.url === "string") return o.url;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

function pickUrls(s: string): string[] | undefined {
  if (!s) return undefined;
  const out: string[] = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0].replace(/[.,;:]+$/, ""));
  return out.length ? out : undefined;
}

// ============================================================================
// Row → FirmCandidate / PersonCandidate / EdgeCandidate
// ============================================================================

function assembleResult(
  table: AirtableTablePayload,
  sourceUrl: string,
  seedHints: SeedHints,
  collection: string | null,
  errors: string[],
): FirmlistImportResult {
  const colById = new Map<string, AirtableColumn>();
  for (const c of table.columns) colById.set(c.id, c);

  // Build foreign-table primary lookups (multipleRecordLinks → name).
  const foreignPrimary = new Map<string, string>();
  if (table.foreignTables) {
    for (const ft of Object.values(table.foreignTables)) {
      for (const r of ft.rows ?? []) {
        if (r.id && r.primary) foreignPrimary.set(r.id, r.primary);
      }
    }
  }

  const firms: KeyedFirmCandidate[] = [];
  const people: KeyedPersonCandidate[] = [];
  const edges: EdgeCandidate[] = [];
  const childUrls = new Set<string>();
  const seenKeys = new Set<string>();
  const stubEntities: Array<{ import_key: string; kind: "firm" | "person"; name: string }> = [];
  // Aggregate every cell value once so we can re-run the Task-20 URL
  // extractor over the full row set instead of regex-scanning per cell.
  const rowsForUrlExtract: Array<Record<string, string>> = [];

  for (const row of table.rows) {
    const cellsRaw = row.cellValuesByColumnId ?? row.cellsByColumnId ?? {};
    // Build normalized cells: {canonicalKey → text, raw, links, urls}.
    const cells: Record<string, ExtractedCell & { col: AirtableColumn; canon: string | null }> = {};
    const rowTextByHeader: Record<string, string> = {};
    for (const [cid, raw] of Object.entries(cellsRaw)) {
      const col = colById.get(cid) ?? { id: cid, name: cid, type: "text" };
      const x = extractCell(col, raw);
      const canon = canonicalFieldKey(col.name);
      cells[cid] = { ...x, col, canon };
      if (x.text) rowTextByHeader[col.name || cid] = x.text;
    }
    rowsForUrlExtract.push(rowTextByHeader);

    const keyed: Record<string, string> = {};
    for (const c of Object.values(cells)) {
      if (c.canon && c.text) keyed[c.canon] = c.text;
    }

    const importKey = `airtable:${table.id}:${row.id}`;
    if (seenKeys.has(importKey)) continue;
    seenKeys.add(importKey);

    const kind = decideKind(keyed);
    if (kind === "company") {
      const firm = toFirmCandidate(keyed, sourceUrl);
      if (firm) {
        firm.import_key = importKey;
        applySeedHintsFirm(firm, seedHints);
        if (collection) firm.notes = `${firm.notes ?? ""}\ncollection:${collection}`.trim();
        firms.push(firm);
      }
    } else {
      const person = toPersonCandidate(keyed, sourceUrl, seedHints);
      if (person) {
        person.import_key = importKey;
        applySeedHints(person, seedHints);
        if (collection) {
          const tags = new Set<string>(person.tags ?? []);
          tags.add(`collection:${collection}`);
          person.tags = [...tags];
        }
        people.push(person);
      }
    }

    // multipleRecordLinks → EdgeCandidates. Resolve linked-record ids
    // against `foreignTables`; emit a `works_at` (person→company) or
    // `linked_to` (company→company) edge.
    for (const c of Object.values(cells)) {
      if (!c.links?.length) continue;
      const colName = c.col.name.toLowerCase();
      // Decide edge kind from column name + canonical mapping.
      const edgeKind =
        /company|firm|fund|organization|employer|workplace/.test(colName) ? "works_at" :
        /portfolio|invest/.test(colName) ? "invested_in" :
        /partner/.test(colName) ? "partner_at" :
        "linked_to";
      for (const linkedId of c.links) {
        const toKey = `airtable:${c.col.foreignTableId ?? table.id}:${linkedId}`;
        // Materialize the linked foreign record so the pipeline can
        // persist the edge. Firm edges (works_at / partner_at /
        // invested_in / linked_to) target a firm; everything else
        // defaults to firm as well since Airtable relation columns
        // almost always link rows in another firm-shaped table.
        const primary = foreignPrimary.get(linkedId);
        if (!seenKeys.has(toKey)) {
          seenKeys.add(toKey);
          if (primary) {
            const stubKind: "firm" | "person" = edgeKind === "works_at" ? "person" : "firm";
            // Heuristic: a "works_at" edge points from the row (person)
            // to the firm — so the linked record IS the firm. Override
            // the default and keep stubKind="firm" for that case.
            stubEntities.push({
              import_key: toKey,
              kind: edgeKind === "works_at" ? "firm" : stubKind,
              name: primary,
            });
          }
        }
        edges.push({ from_key: importKey, to_key: toKey, kind: edgeKind });
      }
    }
  }

  // Task-20 URL extraction: scan every cell value once for inline URLs
  // (Notes/Thesis free text, plus bare hostnames like "acme.vc"). The
  // pipeline fans these out as child kind='url' scrape jobs.
  for (const u of extractUrlsFromRows(rowsForUrlExtract)) {
    if (isUsefulChildUrl(u)) childUrls.add(u);
  }

  return {
    firms,
    people,
    edges,
    childUrls: [...childUrls],
    stubEntities,
    totalSeen: table.rows.length,
    errors: errors.length ? errors : undefined,
    sourceCollection: collection,
  };
}

const PERSON_CANON_HINTS = new Set(["email", "linkedin", "title", "first_name", "last_name", "phone"]);
const FIRM_CANON_HINTS = new Set(["website", "thesis", "stages", "sectors", "geo_focus", "aum", "fund_size", "check_size"]);

function decideKind(keyed: Record<string, string>): "person" | "company" {
  let personScore = 0, firmScore = 0;
  for (const k of Object.keys(keyed)) {
    if (PERSON_CANON_HINTS.has(k)) personScore += 1;
    if (FIRM_CANON_HINTS.has(k)) firmScore += 1;
  }
  if (personScore > firmScore) return "person";
  if (firmScore > 0) return "company";
  // Fall back to name shape: spaces + non-corporate suffix → person.
  const name = keyed.name ?? "";
  if (/\s/.test(name) && !/inc\.?|ltd\.?|llc|gmbh|capital|ventures|partners|fund|labs|studio/i.test(name)) {
    return "person";
  }
  return "company";
}

function toFirmCandidate(k: Record<string, string>, sourceUrl: string): KeyedFirmCandidate | null {
  const name = k.name?.trim();
  if (!name) return null;
  const website = normalizeUrl(k.website);
  const domain = website ? extractDomain(website) || null : null;
  const cand: KeyedFirmCandidate = {
    name,
    website,
    domain,
    linkedin_url: normalizeUrl(k.linkedin),
    crunchbase_url: normalizeUrl(k.crunchbase),
    twitter_handle: stripHandle(k.twitter),
    hq_city: k.city ?? null,
    hq_country_iso2: k.country ? countryToIso2(k.country) : null,
    thesis: k.thesis ?? k.notes ?? null,
    sectors: splitList(k.sectors),
    stages: splitList(k.stages),
    geo_focus: splitList(k.geo_focus),
    contact_email: k.email ?? null,
    source_url: sourceUrl,
  };
  if (k.check_size) {
    const r = parseUsdRange(k.check_size);
    cand.check_size_min_usd = r.min;
    cand.check_size_max_usd = r.max;
    cand.check_size_typical_usd = r.typical;
  }
  // Quality gate: never fabricate a domain — upsertFirm will reject if
  // both are missing, so drop the row here to keep error logs clean.
  if (!cand.domain && !cand.website) return null;
  return cand;
}

function toPersonCandidate(k: Record<string, string>, sourceUrl: string, seed: SeedHints): KeyedPersonCandidate | null {
  let name = k.name?.trim();
  if (!name && (k.first_name || k.last_name)) {
    name = [k.first_name, k.last_name].filter(Boolean).join(" ").trim();
  }
  if (!name) return null;
  return {
    name,
    email: k.email ?? null,
    title: k.title ?? null,
    org: k.company ?? null,
    category: seed.role_hint,
    linkedin_url: normalizeUrl(k.linkedin),
    twitter_url: normalizeUrl(k.twitter),
    github_url: normalizeUrl(k.github),
    personal_url: normalizeUrl(k.website),
    country_iso2: k.country ? countryToIso2(k.country) : null,
    region: k.region ?? null,
    city: k.city ?? null,
    bio: k.thesis ?? k.notes ?? k.bio ?? null,
    tags: null,
    source_domain: "airtable.com",
    source_url: sourceUrl,
  };
}

// ============================================================================
// Field-name canonicalization (alias → canonical key used by the row
// → candidate mappers). Mirrors the alias dict in imports/auto_map.ts
// but kept inline so this importer is self-contained.
// ============================================================================

const FIELD_ALIASES: Array<[RegExp, string]> = [
  [/^(full[\s_]?name|name|person\s*name|firm|fund|investor|company|organization|gp\s*name)$/i, "name"],
  [/^first[\s_]?name$/i, "first_name"],
  [/^last[\s_]?name$/i, "last_name"],
  [/^(email|e[-_]?mail|contact[\s_]?email)$/i, "email"],
  [/^(phone|tel|mobile)$/i, "phone"],
  [/^(linked[\s_-]?in|li\b)$/i, "linkedin"],
  [/^(twitter|x|x\s*handle)$/i, "twitter"],
  [/^github$/i, "github"],
  [/^(website|url|site|homepage|web|link)$/i, "website"],
  [/^crunchbase$/i, "crunchbase"],
  [/^(title|role|position|job[\s_]?title)$/i, "title"],
  [/^(company|firm|fund|organization|employer|workplace)$/i, "company"],
  [/^(sector|industry|industries|vertical)s?$/i, "sectors"],
  [/^(stage|round)s?$/i, "stages"],
  [/^(geo|geograph(?:y|ies)|region|regions|markets?)$/i, "geo_focus"],
  [/^(city|town|hq[\s_]?city)$/i, "city"],
  [/^(country|nation|hq[\s_]?country)$/i, "country"],
  [/^(state|province|hq[\s_]?region)$/i, "region"],
  [/^(thesis|focus|description|about|summary|notes?|comments?)$/i, "thesis"],
  [/^bio$/i, "bio"],
  [/^(check[\s_]?size|ticket[\s_]?size|investment[\s_]?size)$/i, "check_size"],
  [/^(aum|assets[\s_]?under[\s_]?management)$/i, "aum"],
  [/^(fund[\s_]?size|current[\s_]?fund[\s_]?size)$/i, "fund_size"],
];

function canonicalFieldKey(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  for (const [re, c] of FIELD_ALIASES) if (re.test(s)) return c;
  return null;
}

function normalizeUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`;
  return null;
}

function stripHandle(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim().replace(/^@/, "");
  if (!s) return null;
  return s.replace(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//i, "").split(/[/?#]/)[0] || null;
}

function splitList(v: string | null | undefined): string[] | null {
  if (!v) return null;
  const parts = String(v).split(/[,;/|]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function countryToIso2(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (s.length === 2) return s.toUpperCase();
  return countryNameToIso2(s) || null;
}

function isUsefulChildUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    if (host === "airtable.com" || host.endsWith(".airtable.com")) return false;
    if (host === "dl.airtable.com" || host === "v5.airtableusercontent.com") return false;
    // Image / attachment URLs are skipped — only profile/personal links matter.
    if (/\.(png|jpe?g|gif|webp|svg|ico|pdf|csv|xlsx?)(\?|#|$)/i.test(u)) return false;
    // classifyUrl returns "firmlist" | "profile" | "url" — any of the
    // three is a useful child URL once Airtable/asset hosts are filtered.
    const kind = classifyUrl(u);
    return kind === "firmlist" || kind === "profile" || kind === "url";
  } catch { return false; }
}

// ============================================================================
// Seed-source hints
// ============================================================================

interface SeedHints {
  role_hint: string | null;
  country: string | null;
  region: string | null;
}

const AIRTABLE_SEED_HINTS_BY_SHARE: Record<string, SeedHints> = {
  // Pre-seeded share/explore ids — see seed-sources.json.
};

function lookupSeedHints(url: string): SeedHints {
  const parsed = parseAirtableUrl(url);
  const key = parsed?.shareId ?? parsed?.expId ?? "";
  const exact = AIRTABLE_SEED_HINTS_BY_SHARE[key];
  if (exact) return exact;
  const lower = url.toLowerCase();
  const region =
    /middle.?east/.test(lower) ? "middle_east" :
    /europe|emea/.test(lower) ? "europe" :
    /latam|latin.?america/.test(lower) ? "latam" :
    /south.?east.?asia|sea\b/.test(lower) ? "sea" :
    /africa/.test(lower) ? "africa" :
    null;
  const country =
    /\bfrench|france\b/.test(lower) ? "FR" :
    /\b(us|usa|united.?states|american)\b/.test(lower) ? "US" :
    /\b(uk|britain|british)\b/.test(lower) ? "GB" :
    null;
  const roleHint =
    /angel/.test(lower) ? "angel" :
    /\bvc|venture\b/.test(lower) ? "vc_partner" :
    /founder/.test(lower) ? "founder" :
    null;
  return { role_hint: roleHint, country, region };
}

function applySeedHints(p: KeyedPersonCandidate, h: SeedHints): void {
  const tags = new Set<string>(p.tags ?? []);
  if (h.role_hint) { tags.add(`role:${h.role_hint}`); if (!p.category) p.category = h.role_hint; }
  if (h.region) tags.add(`geo_region:${h.region}`);
  if (h.country) { tags.add(`country:${h.country}`); if (!p.country_iso2) p.country_iso2 = h.country; }
  if (tags.size) p.tags = [...tags];
}

function applySeedHintsFirm(f: KeyedFirmCandidate, h: SeedHints): void {
  if (h.role_hint && !f.kind) f.kind = h.role_hint === "vc_partner" ? "vc" : h.role_hint;
  if (h.country && !f.hq_country_iso2) f.hq_country_iso2 = h.country;
  if (h.region && !f.hq_region) f.hq_region = h.region;
  const geo = new Set<string>(f.geo_focus ?? []);
  if (h.region) geo.add(h.region);
  if (h.country) geo.add(h.country);
  if (geo.size) f.geo_focus = [...geo];
}

// ============================================================================
// Schema cache (per-share, per-table)
// ============================================================================

async function loadSchemaCache(env: Env, shareId: string, tableId: string): Promise<AirtableColumn[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT schema_json FROM airtable_share_schema_cache WHERE share_id = ? AND table_id = ?`,
    ).bind(shareId, tableId).first<{ schema_json: string }>();
    if (!row?.schema_json) return null;
    const arr = JSON.parse(row.schema_json);
    return Array.isArray(arr) ? (arr as AirtableColumn[]) : null;
  } catch { return null; }
}

async function saveSchemaCache(
  env: Env,
  shareId: string,
  tableId: string,
  cols: AirtableColumn[],
  collection: string | null,
): Promise<void> {
  if (!cols.length) return;
  const now = new Date().toISOString();
  const ctx = collection ? JSON.stringify({ collection }) : null;
  await env.DB.prepare(
    `INSERT INTO airtable_share_schema_cache (share_id, table_id, schema_json, context_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(share_id, table_id) DO UPDATE SET
       schema_json  = excluded.schema_json,
       context_json = excluded.context_json,
       fetched_at   = excluded.fetched_at`,
  ).bind(shareId, tableId, JSON.stringify(cols), ctx, now).run();
}

// ============================================================================
// Utility walkers
// ============================================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function walk(blob: unknown, visit: (v: unknown) => void): void {
  const stack: unknown[] = [blob];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;
    visit(cur);
    if (typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) for (const v of cur) stack.push(v);
    else for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
  }
}

function deepFindString(blob: unknown, pred: (s: string) => boolean): string | null {
  let found: string | null = null;
  walk(blob, (v) => {
    if (found) return;
    if (typeof v === "string" && pred(v)) found = v;
  });
  return found;
}

function extractInitialData(html: string): unknown | null {
  // Airtable Universe pages: `window.__INITIAL_DATA__ = {...};`
  const m = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
}

export type { FirmCandidate, FirmlistImportResult } from "./types";
