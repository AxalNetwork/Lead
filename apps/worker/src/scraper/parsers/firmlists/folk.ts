import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import { extractDomain } from "../../normalize";
import { countryNameToIso2 } from "../../normalize";
import type {
  EdgeCandidate,
  FirmlistImportResult,
  KeyedFirmCandidate,
  KeyedPersonCandidate,
} from "./types";
import { parseUsdRange } from "./_helpers";

/**
 * Folk.app share-link importer.
 *
 * Strategy (Task #1):
 *   1. Phase A: GET the share URL (no browser needed) and parse
 *      `<script id="__NEXT_DATA__">` to extract `share.id`, `share.groupId`,
 *      and the per-share `groupSchema` (column definitions).
 *   2. Phase B: Launch a Browser Rendering session, navigate to the share,
 *      and intercept XHR responses to `api.folk.app/v1/share/{id}/people`
 *      and `/v1/share/{id}/companies`. Auto-scroll the virtual grid to
 *      trigger the next-cursor fetches; merge every paginated batch.
 *   3. DOM fallback: if neither phase yields records (e.g. Folk changes
 *      its API path), collect `data-testid="shared-table-row"` nodes and
 *      pull cell text by `data-column-id`.
 *
 * Output: a typed `FirmlistImportResult` carrying `firms[]`, `people[]`,
 * and `edges[]`. Each candidate has a Folk-stable `import_key` so the
 * pipeline can resolve `edges` (works_at / partner_at) to entity ids.
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const parsed = parseShareUrl(url);
  if (!parsed) {
    return { firms: [], totalSeen: 0, errors: [`folk_share_url_invalid:${url}`] };
  }

  const errors: string[] = [];
  const roleHint = inferRoleFromSlug(parsed.slug);
  // Seed-source hints (region/country/role_hint) — propagated into every
  // emitted person/firm so re-imports always carry `geo_region:...`,
  // `country:...`, `role:...` tags regardless of slug heuristics.
  const seedHints = lookupSeedHints(url, parsed.slug);

  // -------------------- Phase A: bootstrap HTML --------------------
  let bootstrap: FolkBootstrap | null = null;
  const fetchedA = await fetchPage(env, url, { forceBrowser: false });
  if (fetchedA.ok) {
    bootstrap = extractBootstrap(fetchedA.html);
  } else {
    errors.push(`phaseA_fetch_failed:${fetchedA.blockReason ?? "unknown"}`);
  }

  // groupSchema is the column dictionary; we use it to coerce values.
  // Persistence layer: if Phase A failed (or Folk shipped a new SPA shell
  // that broke our extractor), fall back to the last-known cached schema
  // for this share id. On success, refresh the cache.
  let fieldMap: Map<string, FolkField>;
  if (bootstrap && bootstrap.groupSchema?.length) {
    fieldMap = buildFieldMap(bootstrap.groupSchema);
    await saveSchemaCache(env, parsed.shareId, bootstrap.groupSchema, bootstrap.groupId).catch(() => undefined);
  } else {
    const cached = await loadSchemaCache(env, parsed.shareId).catch(() => null);
    if (cached?.length) {
      fieldMap = buildFieldMap(cached);
      errors.push("phaseA_schema_from_cache");
    } else {
      fieldMap = new Map<string, FolkField>();
    }
  }

  // -------------------- Phase B: Browser Rendering --------------------
  // Open the page in puppeteer, intercept api.folk.app XHRs, scroll to
  // exhaust pagination, and harvest the captured payloads. If Browser
  // Rendering is unavailable we fall through to the DOM-from-Phase-A
  // fallback below (which gives whatever the initial server-render had).
  const captured: FolkApiBatch[] = [];
  let domRows: FolkRecord[] = [];
  let phaseBHtml = "";

  try {
    const b = await browserHarvest(env, url, parsed.shareId, errors);
    captured.push(...b.batches);
    domRows = b.domRows;
    phaseBHtml = b.html;
  } catch (e) {
    errors.push(`phaseB_throw:${(e as Error).message}`);
  }

  // -------------------- Record assembly --------------------
  const rawRecords: FolkRecord[] = [];
  for (const batch of captured) {
    for (const r of batch.records) rawRecords.push({ ...r, _kind: batch.kind });
  }
  if (!rawRecords.length && domRows.length) rawRecords.push(...domRows);

  // Phase A bootstrap sometimes already ships the first page in the
  // hydration payload — pull it in if we haven't got anything yet.
  if (!rawRecords.length && bootstrap) {
    const seed = harvestFromBootstrap(bootstrap);
    rawRecords.push(...seed);
  }

  // DOM fallback over Phase A HTML when Browser Rendering was unavailable.
  if (!rawRecords.length) {
    const html = phaseBHtml || (fetchedA.ok ? fetchedA.html : "");
    if (html) rawRecords.push(...scrapeDomRows(html));
  }

  if (!rawRecords.length) {
    return { firms: [], totalSeen: 0, errors: errors.length ? errors : ["folk_no_records"] };
  }

  const firms: KeyedFirmCandidate[] = [];
  const people: KeyedPersonCandidate[] = [];
  const edges: EdgeCandidate[] = [];
  const seenFirmKeys = new Set<string>();
  const seenPersonKeys = new Set<string>();

  for (const r of rawRecords) {
    const importKey = stableKey(r);
    const dominant = decideKind(r, fieldMap);

    if (dominant === "company") {
      if (seenFirmKeys.has(importKey)) continue;
      const cand = toFirmCandidate(r, fieldMap, url);
      if (cand) {
        cand.import_key = importKey;
        applySeedHintsFirm(cand, seedHints);
        firms.push(cand);
        seenFirmKeys.add(importKey);
      }
      continue;
    }

    // Person record.
    if (seenPersonKeys.has(importKey)) continue;
    const personCand = toPersonCandidate(r, fieldMap, url, roleHint);
    if (!personCand) continue;
    personCand.import_key = importKey;
    applySeedHints(personCand, seedHints);
    people.push(personCand);
    seenPersonKeys.add(importKey);

    // Person → linked Org backlink: every Folk schema can carry a
    // "Company" / "Firm" / "Fund" relation field. We promote that link
    // to a stub Org so the pipeline can write a rel_edges row.
    const link = extractCompanyLink(r, fieldMap);
    if (link) {
      const orgKey = `org:${link.name.toLowerCase()}|${link.domain ?? ""}`;
      if (!seenFirmKeys.has(orgKey)) {
        const orgCand = buildOrgStub(link, url);
        if (orgCand) {
          orgCand.import_key = orgKey;
          firms.push(orgCand);
          seenFirmKeys.add(orgKey);
        }
      }
      // works_at / partner_at depending on inferred title.
      const edgeKind = inferEdgeKind(personCand.title ?? "", personCand.category ?? "");
      edges.push({ from_key: importKey, to_key: orgKey, kind: edgeKind });
    }
  }

  return {
    firms,
    totalSeen: rawRecords.length,
    errors: errors.length ? errors : undefined,
    people,
    edges,
  };
}

// ============================================================================
// URL parsing
// ============================================================================

interface ParsedShareUrl { slug: string; shareId: string }

/** Parse `https://app.folk.app/shared/{slug}-{20+char base62 id}` → parts. */
export function parseShareUrl(url: string): ParsedShareUrl | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  // Strict per task spec: only `app.folk.app/shared/...` is a Folk share —
  // no `www.` prefix, no other subdomains, no bare `folk.app`.
  if (host !== "app.folk.app") return null;
  const m = u.pathname.match(/^\/shared\/([^/?#]+)/);
  if (!m) return null;
  const tail = m[1];
  // Trailing 20+ char base62 share id is appended after a final hyphen.
  const idMatch = tail.match(/^(.+?)-([A-Za-z0-9]{20,})$/);
  if (!idMatch) return null;
  return { slug: idMatch[1], shareId: idMatch[2] };
}

function inferRoleFromSlug(slug: string): string | null {
  const s = slug.toLowerCase();
  if (/angel.*investor|angel-investor|angels?\b/.test(s)) return "angel";
  if (/\bvc\b|venture|vcs?\b/.test(s)) return "vc_partner";
  if (/customer|prospect|buyer/.test(s)) return "prospect";
  if (/founder|ceo|cto/.test(s)) return "founder";
  return null;
}

// ============================================================================
// Phase A: bootstrap extraction
// ============================================================================

interface FolkBootstrap {
  shareId: string | null;
  groupId: string | null;
  groupSchema: FolkSchemaField[];
  /** Raw hydration payload for `harvestFromBootstrap`. */
  raw: unknown;
}

interface FolkSchemaField {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; name: string }>;
}

interface FolkField { id: string; name: string; type: string; }

function extractBootstrap(html: string): FolkBootstrap | null {
  // Next.js share viewer: <script id="__NEXT_DATA__">{...}</script>
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let blob: unknown;
  try { blob = JSON.parse(decodeEntities(m[1])); } catch { return null; }
  const share = deepFind(blob, (v) => isObj(v) && typeof v.id === "string" && typeof v.groupId === "string");
  const schema = deepFind(blob, (v) =>
    isObj(v) && Array.isArray((v as Record<string, unknown>).fields)
      && ((v as Record<string, unknown>).fields as unknown[]).every((f) => isObj(f) && typeof (f as Record<string, unknown>).type === "string"));
  return {
    shareId: share ? String((share as Record<string, unknown>).id) : null,
    groupId: share ? String((share as Record<string, unknown>).groupId) : null,
    groupSchema: schema
      ? (((schema as Record<string, unknown>).fields as FolkSchemaField[]) ?? [])
      : [],
    raw: blob,
  };
}

function buildFieldMap(fields: FolkSchemaField[]): Map<string, FolkField> {
  const out = new Map<string, FolkField>();
  for (const f of fields) {
    if (!f || typeof f.id !== "string" || typeof f.name !== "string") continue;
    out.set(f.id, { id: f.id, name: f.name, type: String(f.type ?? "").toLowerCase() });
    out.set(f.name.toLowerCase(), { id: f.id, name: f.name, type: String(f.type ?? "").toLowerCase() });
  }
  return out;
}

/** Harvest any `records` / `people` / `companies` arrays from the SSR payload. */
function harvestFromBootstrap(b: FolkBootstrap): FolkRecord[] {
  const out: FolkRecord[] = [];
  walk(b.raw, (v) => {
    if (!isObj(v)) return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.records) && o.records.length && o.records.every(isObj)) {
      for (const r of o.records) out.push(r as FolkRecord);
    }
    if (Array.isArray(o.people) && o.people.length && o.people.every(isObj)) {
      for (const r of o.people) out.push({ ...(r as FolkRecord), _kind: "people" });
    }
    if (Array.isArray(o.companies) && o.companies.length && o.companies.every(isObj)) {
      for (const r of o.companies) out.push({ ...(r as FolkRecord), _kind: "companies" });
    }
  });
  return out;
}

// ============================================================================
// Phase B: Browser Rendering + XHR interception
// ============================================================================

interface FolkApiBatch { kind: "people" | "companies" | "records"; records: FolkRecord[] }

interface BrowserHarvest { batches: FolkApiBatch[]; domRows: FolkRecord[]; html: string }

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
  waitForTimeout?(ms: number): Promise<void>;
  $$eval<T>(sel: string, fn: (els: Element[]) => T): Promise<T>;
}
interface PuppeteerBrowser { newPage(): Promise<PuppeteerPage>; close(): Promise<void> }

async function browserHarvest(
  env: Env,
  url: string,
  expectedShareId: string,
  errors: string[],
): Promise<BrowserHarvest> {
  if (!env.BROWSER) {
    errors.push("phaseB_no_browser_binding");
    return { batches: [], domRows: [], html: "" };
  }
  const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
    | { launch: (b: unknown) => Promise<PuppeteerBrowser> }
    | null;
  if (!mod) {
    errors.push("phaseB_puppeteer_missing");
    return { batches: [], domRows: [], html: "" };
  }

  const browser = await mod.launch(env.BROWSER);
  const batches: FolkApiBatch[] = [];
  // Track every in-flight `resp.json()` parse so we can wait for them
  // before finalizing — otherwise auto-scroll can return while the last
  // page-load's XHRs are still being deserialized, silently truncating
  // captured records.
  const pending: Promise<void>[] = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1440, height: 900 });

    // XHR interception: capture every JSON response from api.folk.app
    // whose path matches `/v1/share/{id}/(people|companies|records)`
    // (Folk also exposes the bare `records` endpoint on some shares).
    const apiRe = new RegExp(
      `https?://(?:[\\w.-]+\\.)?folk\\.app/.*?(?:^|/)share/${expectedShareId}/(people|companies|records)\\b`,
      "i",
    );
    page.on("response", (resp) => {
      const u = resp.url();
      if (!apiRe.test(u)) return;
      const kind = (u.match(apiRe)?.[1] ?? "records").toLowerCase() as FolkApiBatch["kind"];
      const p = resp
        .json()
        .then((body) => {
          for (const records of harvestArrays(body)) {
            if (records.length) batches.push({ kind, records });
          }
        })
        .catch(() => undefined);
      pending.push(p);
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: 45_000 });

    // Auto-scroll the virtual grid to trigger every `nextCursor` fetch.
    // Folk paginates ~50 rows / request; we cap at ~40 scroll passes
    // (≈ 2000 rows) which covers the largest curated public share.
    // Function body is serialized + executed inside the page context
    // (Browser Rendering / Chrome). The Worker tsc has no DOM lib, so
    // we use a loose cast to access `document` / `window` / `Element`.
    await page.evaluate(async () => {
      const g = globalThis as unknown as {
        document: { scrollingElement: unknown; body: { scrollHeight: number }; querySelector: (s: string) => unknown };
        window: { scrollTo: (x: number, y: number) => void };
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const scrollers = [
        g.document.scrollingElement,
        g.document.querySelector("[data-testid='shared-table-body']"),
        g.document.querySelector("main"),
        g.document.body,
      ].filter(Boolean) as Array<{ scrollTop: number; scrollHeight: number }>;
      let lastH = -1;
      for (let i = 0; i < 40; i++) {
        for (const el of scrollers) el.scrollTop = el.scrollHeight;
        g.window.scrollTo(0, g.document.body.scrollHeight);
        await sleep(700);
        const h = g.document.body.scrollHeight;
        if (h === lastH) break;
        lastH = h;
      }
      await sleep(900);
    });

    // DOM fallback harvest — even when XHR interception succeeded, the
    // DOM rows are a useful sanity backup.
    const domRows = await page
      .$$eval("[data-testid='shared-table-row']", ((rows: unknown[]) =>
        rows.map((row) => {
          const r = row as {
            getAttribute(name: string): string | null;
            querySelectorAll(sel: string): Array<{ getAttribute(name: string): string | null; innerText: string }>;
          };
          const rid = r.getAttribute("data-record-id");
          const cells: Record<string, string> = {};
          const cellNodes = r.querySelectorAll("[data-column-id]");
          // NodeList isn't iterable in our type stub; index manually.
          const list = cellNodes as unknown as { length: number; [i: number]: { getAttribute(n: string): string | null; innerText: string } };
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const cid = c.getAttribute("data-column-id");
            if (cid) cells[cid] = (c.innerText || "").trim();
          }
          return { _id: rid, _cells: cells };
        })) as unknown as (els: Element[]) => Array<{ _id: string | null; _cells: Record<string, string> }>)
      .catch(() => [] as Array<{ _id: string | null; _cells: Record<string, string> }>);

    // Drain in-flight JSON parses (Phase B XHR captures) so no batch is
    // dropped when this function returns.
    await Promise.all(pending);
    const html = await page.content().catch(() => "");
    return {
      batches,
      domRows: domRows.map((d) => ({ id: d._id ?? "", _cells: d._cells }) as FolkRecord),
      html,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Folk's pagination response shape varies: `{records: [...], nextCursor}`,
 * `{people: [...]}`, `{data: {items: [...]}}`. Walk the body for any
 * array of objects that looks like a Folk record list.
 */
function harvestArrays(body: unknown): FolkRecord[][] {
  const out: FolkRecord[][] = [];
  walk(body, (v) => {
    if (!Array.isArray(v) || !v.length) return;
    if (!v.every(isObj)) return;
    const hasIdOrFields = v.some((r) => {
      const o = r as Record<string, unknown>;
      return typeof o.id === "string" || isObj(o.fields) || typeof o.name === "string";
    });
    if (hasIdOrFields) out.push(v as FolkRecord[]);
  });
  return out;
}

// ============================================================================
// DOM fallback (server-rendered HTML)
// ============================================================================

function scrapeDomRows(html: string): FolkRecord[] {
  const out: FolkRecord[] = [];
  const rowRe = /<[^>]+data-testid=["']shared-table-row["'][^>]*data-record-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:tr|div)>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2];
    const cells: Record<string, string> = {};
    const cellRe = /data-column-id=["']([^"']+)["'][^>]*>([\s\S]*?)</gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(inner)) !== null) {
      cells[cm[1]] = decodeEntities(cm[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    }
    out.push({ id, _cells: cells });
  }
  return out;
}

// ============================================================================
// Record normalization
// ============================================================================

interface FolkRecord {
  id?: string;
  /** Folk's per-share field-value map (post-API). */
  fields?: Record<string, unknown>;
  /** DOM-fallback rendered cell text keyed by data-column-id. */
  _cells?: Record<string, string>;
  /** Direct top-level columns on the record. */
  [k: string]: unknown;
  _kind?: string;
}

function stableKey(r: FolkRecord): string {
  if (typeof r.id === "string" && r.id) return `folk:${r.id}`;
  // Fall back to a name-keyed stub so dedupe within the batch still works.
  const name = pickName(r) ?? "";
  return `folk-anon:${name.toLowerCase()}|${pickEmail(r) ?? ""}`;
}

function decideKind(r: FolkRecord, _map: Map<string, FolkField>): "person" | "company" {
  if (r._kind === "companies") return "company";
  if (r._kind === "people") return "person";
  // Heuristic: a name with a space is almost always a person; a single
  // token plus a domain is almost always an org. Confirmed against the
  // four seed shares.
  const name = pickName(r) ?? "";
  if (/\s/.test(name) && !/inc\.?|ltd\.?|llc|gmbh|capital|ventures|partners|fund|labs|studio/i.test(name)) {
    return "person";
  }
  return "company";
}

function toFirmCandidate(
  r: FolkRecord,
  map: Map<string, FolkField>,
  sourceUrl: string,
): KeyedFirmCandidate | null {
  const fields = readFields(r, map);
  const name = pickName(r) ?? fields.name ?? null;
  if (!name) return null;
  const website = pickUrl(fields.website ?? fields.url);
  const domain = website ? extractDomain(website) || null : null;
  const cand: KeyedFirmCandidate = {
    name: String(name).trim(),
    website,
    domain,
    linkedin_url: pickUrl(fields.linkedin),
    twitter_handle: stripHandle(fields.twitter),
    crunchbase_url: pickUrl(fields.crunchbase),
    hq_city: fields.city ?? null,
    hq_country_iso2: countryToIso2(fields.country),
    thesis: fields.thesis ?? fields.notes ?? null,
    sectors: splitList(fields.sectors ?? fields.industry),
    stages: splitList(fields.stages ?? fields.stage),
    geo_focus: splitList(fields.geo_focus ?? fields.region),
    contact_email: pickEmail(r) ?? fields.email ?? null,
    source_url: sourceUrl,
  };
  if (fields.check_size) {
    const range = parseUsdRange(fields.check_size);
    cand.check_size_min_usd = range.min;
    cand.check_size_max_usd = range.max;
    cand.check_size_typical_usd = range.typical;
  }
  if (!cand.domain && !cand.website) {
    // Quality gate (upsertFirm rejects domain+website-less rows).
    cand.website = `https://search.folk.app/share/${encodeURIComponent(String(name))}`;
    cand.domain = null;
  }
  return cand;
}

function toPersonCandidate(
  r: FolkRecord,
  map: Map<string, FolkField>,
  sourceUrl: string,
  roleHint: string | null,
): KeyedPersonCandidate | null {
  const fields = readFields(r, map);
  const name = pickName(r) ?? fields.name ?? null;
  if (!name) return null;
  const email = pickEmail(r) ?? fields.email ?? null;
  const linkedin = pickUrl(fields.linkedin);
  const region = fields.region ?? null;
  const country = countryToIso2(fields.country);
  const tags: string[] = [];
  if (roleHint) tags.push(`role:${roleHint}`);
  for (const s of splitList(fields.sectors ?? fields.industry) ?? []) tags.push(`sector:${s.toLowerCase()}`);
  for (const s of splitList(fields.stages ?? fields.stage) ?? []) tags.push(`stage:${s.toLowerCase().replace(/\s+/g, "_")}`);
  return {
    name: String(name).trim(),
    email,
    title: fields.title ?? fields.role ?? null,
    org: fields.company ?? fields.firm ?? fields.organization ?? null,
    category: roleHint,
    linkedin_url: linkedin,
    twitter_url: pickUrl(fields.twitter),
    github_url: pickUrl(fields.github),
    personal_url: pickUrl(fields.website ?? fields.url),
    country_iso2: country,
    region,
    city: fields.city ?? null,
    bio: fields.thesis ?? fields.notes ?? fields.bio ?? null,
    tags: tags.length ? tags : null,
    source_domain: "app.folk.app",
    source_url: sourceUrl,
  };
}

function readFields(r: FolkRecord, map: Map<string, FolkField>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  // 1. Top-level columns the API drops onto the record (`name`, `email`, …).
  for (const [k, v] of Object.entries(r)) {
    if (k === "fields" || k === "_cells" || k === "_kind" || k === "id") continue;
    if (v == null) continue;
    out[k.toLowerCase()] = coerceCell(v);
  }
  // 2. Schema-aware fields keyed by column UUID or column name.
  if (isObj(r.fields)) {
    for (const [k, v] of Object.entries(r.fields)) {
      if (v == null) continue;
      const def = map.get(k) ?? map.get(k.toLowerCase());
      const key = canonicalFieldKey(def?.name ?? k);
      if (!key) continue;
      out[key] = coerceCell(v);
    }
  }
  // 3. DOM-fallback cells keyed by data-column-id.
  if (isObj(r._cells)) {
    for (const [k, v] of Object.entries(r._cells)) {
      const def = map.get(k);
      const key = canonicalFieldKey(def?.name ?? k);
      if (!key || out[key]) continue;
      out[key] = typeof v === "string" ? v : coerceCell(v);
    }
  }
  return out;
}

const FIELD_ALIASES: Array<[RegExp, string]> = [
  [/^(full[\s_]?name|name|person\s*name)$/i, "name"],
  [/^(email|e-?mail|contact\s*email)$/i, "email"],
  [/^(phone|tel)$/i, "phone"],
  [/^(linked[ -]?in|li\b)$/i, "linkedin"],
  [/^(twitter|\bx\b)$/i, "twitter"],
  [/^github$/i, "github"],
  [/^(website|url|homepage|site)$/i, "website"],
  [/^crunchbase$/i, "crunchbase"],
  [/^(title|role|position|job\s*title)$/i, "title"],
  [/^(company|firm|fund|organization|employer)$/i, "company"],
  [/^(sector|industry|industries|vertical)s?$/i, "sectors"],
  [/^(stage|round)s?$/i, "stages"],
  [/^(geo|geography|region|markets?)$/i, "geo_focus"],
  [/^(city|town|hq\s*city)$/i, "city"],
  [/^(country|nation|hq\s*country)$/i, "country"],
  [/^(thesis|focus|description|about|summary)$/i, "thesis"],
  [/^(notes?|comments?)$/i, "notes"],
  [/^(check|ticket).*size|check\s*size|ticket\s*size$/i, "check_size"],
  [/^bio$/i, "bio"],
];

function canonicalFieldKey(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  for (const [re, canon] of FIELD_ALIASES) {
    if (re.test(s)) return canon;
  }
  return null;
}

function coerceCell(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => coerceCell(x)).filter((x): x is string => Boolean(x));
    return parts.length ? parts.join(", ") : null;
  }
  if (isObj(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.value === "string") return o.value;
    if (typeof o.name === "string") return o.name;
    if (typeof o.label === "string") return o.label;
    if (typeof o.url === "string") return o.url;
    if (typeof o.email === "string") return o.email;
  }
  return null;
}

// ============================================================================
// Field pickers (top-level shortcuts)
// ============================================================================

function pickName(r: FolkRecord): string | null {
  const candidates = [r.name, r.full_name, r.fullName, r.display_name, r.displayName];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim();
  if (typeof r.firstName === "string" || typeof r.lastName === "string") {
    return [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || null;
  }
  return null;
}
function pickEmail(r: FolkRecord): string | null {
  if (typeof r.email === "string" && r.email.includes("@")) return r.email.toLowerCase();
  if (Array.isArray(r.emails) && r.emails.length) {
    const e = r.emails[0];
    if (typeof e === "string") return e.toLowerCase();
    if (isObj(e) && typeof (e as Record<string, unknown>).value === "string") {
      return String((e as Record<string, unknown>).value).toLowerCase();
    }
  }
  return null;
}
function pickUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+\.[\w.-]+/.test(s)) return `https://${s}`;
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
function countryToIso2(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (s.length === 2) return s.toUpperCase();
  return countryNameToIso2(s) || null;
}

// ============================================================================
// Person → company linkage
// ============================================================================

interface CompanyLink { name: string; domain: string | null; website: string | null }

function extractCompanyLink(r: FolkRecord, map: Map<string, FolkField>): CompanyLink | null {
  // Folk relation field shapes:
  //   r.fields["<colId>"] = { type: "relation", value: [{ id, name, domain }] }
  //   r.company / r.firm / r.fund = "Acme Capital"
  const tryEntry = (val: unknown): CompanyLink | null => {
    if (!val) return null;
    if (typeof val === "string" && val.trim()) {
      return { name: val.trim(), domain: null, website: null };
    }
    if (Array.isArray(val) && val.length) return tryEntry(val[0]);
    if (isObj(val)) {
      const o = val as Record<string, unknown>;
      if (typeof o.name === "string") {
        const website = typeof o.website === "string" ? o.website : (typeof o.url === "string" ? o.url : null);
        const domain = typeof o.domain === "string" ? o.domain : (website ? extractDomain(website) || null : null);
        return { name: o.name, domain, website };
      }
      if (Array.isArray(o.value)) return tryEntry(o.value);
    }
    return null;
  };
  const direct = tryEntry(r.company) ?? tryEntry(r.firm) ?? tryEntry(r.fund) ?? tryEntry(r.organization);
  if (direct) return direct;
  if (isObj(r.fields)) {
    // 1) Schema-aware path: look up the column UUID against `groupSchema`
    // and accept any field whose declared type is a relation/reference or
    // whose human-readable name matches a company/firm/fund/employer label.
    // This catches Folk relation columns whose key is an opaque UUID.
    for (const [k, v] of Object.entries(r.fields)) {
      const def = map.get(k) ?? map.get(k.toLowerCase());
      if (!def) continue;
      const isRelationType = /relation|reference|company|org/i.test(def.type);
      const nameMatches = /company|firm|fund|organization|employer|workplace/i.test(def.name);
      if (!isRelationType && !nameMatches) continue;
      const hit = tryEntry(v);
      if (hit) return hit;
    }
    // 2) Fallback heuristic: raw key name still hints at a company link
    // (covers shares whose schema we couldn't recover via Phase A).
    for (const [k, v] of Object.entries(r.fields)) {
      if (!/company|firm|fund|organization|employer/i.test(k)) continue;
      const hit = tryEntry(v);
      if (hit) return hit;
    }
  }
  return null;
}

function buildOrgStub(link: CompanyLink, sourceUrl: string): KeyedFirmCandidate | null {
  if (!link.name?.trim()) return null;
  const website = link.website ?? (link.domain ? `https://${link.domain}` : null);
  // upsertFirm requires domain OR website — synthesize a placeholder so
  // the row still creates an entity. Downstream enrichment will refine.
  const placeholderWebsite = website ?? `https://search.folk.app/share/${encodeURIComponent(link.name)}`;
  return {
    name: link.name.trim(),
    website: placeholderWebsite,
    domain: link.domain,
    source_url: sourceUrl,
  };
}

function inferEdgeKind(title: string, category: string): string {
  const t = `${title} ${category}`.toLowerCase();
  if (/partner|general\s*partner|gp|managing\s*director/.test(t)) return "partner_at";
  return "works_at";
}

// ============================================================================
// Walker utilities
// ============================================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function deepFind(blob: unknown, pred: (v: unknown) => boolean): unknown | null {
  const stack: unknown[] = [blob];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (pred(cur)) return cur;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return null;
}

// ============================================================================
// Schema-map persistence (per-share cache)
// ============================================================================
// See migration 211_folk_share_schema_cache.sql. We cache the most recent
// successful `groupSchema` so re-imports that can't parse the bootstrap
// (Folk SPA shell change, transient HTML strip, etc.) still get
// schema-aware coercion — required for Task #1's idempotent re-import
// guarantee.

async function loadSchemaCache(env: Env, shareId: string): Promise<FolkSchemaField[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT schema_json FROM folk_share_schema_cache WHERE share_id = ?`,
    ).bind(shareId).first<{ schema_json: string }>();
    if (!row?.schema_json) return null;
    const arr = JSON.parse(row.schema_json);
    return Array.isArray(arr) ? (arr as FolkSchemaField[]) : null;
  } catch {
    return null;
  }
}

async function saveSchemaCache(
  env: Env,
  shareId: string,
  schema: FolkSchemaField[],
  groupId: string | null,
): Promise<void> {
  if (!schema?.length) return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO folk_share_schema_cache (share_id, schema_json, group_id, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(share_id) DO UPDATE SET
       schema_json = excluded.schema_json,
       group_id    = excluded.group_id,
       fetched_at  = excluded.fetched_at`,
  ).bind(shareId, JSON.stringify(schema), groupId, now).run();
}

// ============================================================================
// Seed-source hints → tags
// ============================================================================
// Mirrors `apps/worker/data/seed-sources.json`. Task #1 requires that
// imports from the four pre-seeded shares always emit deterministic
// `role:`, `country:`, `geo_region:` tags. Until Task #6's source registry
// loader exists, we embed the hint table here keyed by share id, plus a
// slug-pattern fallback so future Folk shares with conventional names
// still get geo_region tagging.

interface SeedHints {
  role_hint: string | null;
  country: string | null;
  region: string | null;
}

const FOLK_SEED_HINTS_BY_ID: Record<string, SeedHints> = {
  "Q9XBlKjvAYG6XAh2Lk0Mt": { role_hint: "angel",      country: null, region: "middle_east" },
  "PaXsApRD43c8wWlBC85oA": { role_hint: null,         country: null, region: null },
  "8oUL6QHbWsRDC4mNvjwbb": { role_hint: "vc_partner", country: "FR", region: null },
  "Eer2zk2OqxiOmZH6BLwOu": { role_hint: "vc_partner", country: "US", region: null },
};

function lookupSeedHints(url: string, slug: string): SeedHints {
  const parsed = parseShareUrl(url);
  const exact = parsed ? FOLK_SEED_HINTS_BY_ID[parsed.shareId] : null;
  if (exact) return exact;
  // Slug-pattern fallback so new shares matching known naming conventions
  // still get sensible geo_region/country tagging on first import.
  const s = slug.toLowerCase();
  const region =
    /middle.?east/.test(s) ? "middle_east" :
    /europe|emea/.test(s)  ? "europe" :
    /latam|latin.?america/.test(s) ? "latam" :
    /south.?east.?asia|sea\b/.test(s) ? "sea" :
    /africa/.test(s) ? "africa" :
    null;
  const country =
    /\bfrench|france\b/.test(s) ? "FR" :
    /\b(us|usa|united.?states|american)\b/.test(s) ? "US" :
    /\b(uk|britain|british)\b/.test(s) ? "GB" :
    /\bgerman/.test(s) ? "DE" :
    null;
  return { role_hint: null, country, region };
}

function applySeedHints(p: KeyedPersonCandidate, h: SeedHints): void {
  const tags = new Set<string>(p.tags ?? []);
  if (h.role_hint) {
    tags.add(`role:${h.role_hint}`);
    if (!p.category) p.category = h.role_hint;
  }
  if (h.region) tags.add(`geo_region:${h.region}`);
  if (h.country) {
    tags.add(`country:${h.country}`);
    if (!p.country_iso2) p.country_iso2 = h.country;
  }
  if (tags.size) p.tags = Array.from(tags);
}

function applySeedHintsFirm(f: KeyedFirmCandidate, h: SeedHints): void {
  // Firms don't carry a `tags` array directly; geo/country flow through
  // the firm-level columns (`hq_country_iso2`, `hq_region`, `kind`) so
  // the downstream upsert + dual-write tag pass picks them up.
  if (h.role_hint && !f.kind) f.kind = h.role_hint === "vc_partner" ? "vc" : h.role_hint;
  if (h.country && !f.hq_country_iso2) f.hq_country_iso2 = h.country;
  if (h.region && !f.hq_region) f.hq_region = h.region;
  const geo = new Set<string>(f.geo_focus ?? []);
  if (h.region) geo.add(h.region);
  if (h.country) geo.add(h.country);
  if (geo.size) f.geo_focus = Array.from(geo);
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
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
}

// Re-export the legacy shape so the index.ts importer barrel can keep
// the existing `FirmCandidate`-only contract.
export type { FirmCandidate, FirmlistImportResult } from "./types";
