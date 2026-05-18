// /api/uploads — file upload + management surface used by the dashboard
// Import-file modal and the uploads.html page.
//
// v2 (Task #2) routes:
//   POST   /api/uploads                  multipart, ≤50 MB
//   POST   /api/uploads/url              JSON {url} for Google Sheets / Airtable
//   GET    /api/uploads                  list
//   GET    /api/uploads/:id              detail (with map + 5-row preview + tabs)
//   POST   /api/uploads/:id/confirm-map  body: {tabs:[{tab_index, intent, intent_subkind, column_map}]}
//                                        OR legacy {column_map, entity, scrape_urls}
//   POST   /api/uploads/:id/save-template body: {name}
//   GET    /api/uploads/:id/templates    list templates matching this signature
//   POST   /api/uploads/:id/templates/:tplId/apply
//   POST   /api/uploads/:id/rerun        re-enqueue parse_file (unconditional)
//   POST   /api/uploads/:id/retry        re-enqueue parse_file or import_file
//                                        (status-gated: only failed/cancelled)
//   DELETE /api/uploads/:id              remove R2 object + row
//
// Task #3: every read/mutate path is scoped to `c.var.email` (the
// Cloudflare Access JWT subject) so an allowlisted operator can only
// see and mutate their own imports.

import { Hono } from "hono";
import type { Env, JobMessage, JobKind } from "../types";

export const uploads = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set(["csv", "tsv", "xlsx", "xls", "ods", "pdf", "png", "jpg", "jpeg", "webp", "html", "htm"]);

function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "file";
}
function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

uploads.post("/", async (c) => {
  let form: FormData;
  try { form = await c.req.formData(); }
  catch { return c.json({ error: "bad_request", message: "expected multipart/form-data" }, 400); }
  const fileEntry = form.get("file") as unknown;
  const file = fileEntry as { name?: string; size?: number; type?: string; stream: () => ReadableStream } | null;
  if (!file || typeof file !== "object" || typeof file.size !== "number" || typeof file.stream !== "function") {
    return c.json({ error: "bad_request", message: "file field required" }, 400);
  }
  if (file.size > MAX_BYTES) return c.json({ error: "too_large", message: "max 50 MB" }, 413);
  const filename = safeName(file.name || "upload");
  const ext = extOf(filename);
  if (!ALLOWED_EXT.has(ext)) return c.json({ error: "unsupported_type", ext }, 415);

  const id = crypto.randomUUID();
  const r2Key = `uploads/${id}/${filename}`;
  await c.env.UPLOADS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO file_imports (id, filename, mime, size, r2_key, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?, ?)`,
  ).bind(id, filename, file.type || null, file.size, r2Key, c.get("email") ?? null, now, now).run();

  const jobId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'parse_file', ?, ?, ?, ?)`,
  ).bind(jobId, `parse_file:${filename}`, "upload", id, JSON.stringify({ importId: id }), now, now).run();
  const msg: JobMessage = { jobId, kind: "parse_file", target: id, config: { importId: id } };
  await c.env.LEAD_QUEUE.send(msg);

  return c.json({ id, filename, size: file.size, status: "uploaded" }, 201);
});

uploads.post("/url", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { url?: string } | null;
  const url = (body?.url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json({ error: "bad_request", message: "url required (http/https)" }, 400);
  }
  // Pull the sheet now so the parse phase has bytes; store as CSV in R2.
  const { fetchAndParseUrl } = await import("../imports/parse");
  const { tables, format } = await fetchAndParseUrl(url);
  if (!tables.length) return c.json({ error: "fetch_failed", message: "could not fetch or parse URL" }, 502);

  const id = crypto.randomUUID();
  const filename = safeName(`${new URL(url).hostname}-${id.slice(0, 8)}.csv`);
  // Stash the original URL in r2_key suffix so re-parse can re-fetch fresh.
  const r2Key = `uploads/${id}/${filename}`;
  // Persist all tabs as a single multi-tab JSON blob the parser will re-read.
  const json = JSON.stringify({ source_url: url, format, tables });
  await c.env.UPLOADS.put(r2Key, json, { httpMetadata: { contentType: "application/json" } });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO file_imports (id, filename, mime, size, r2_key, status, format, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)`,
  ).bind(id, filename, "application/json", json.length, r2Key, format, c.get("email") ?? null, now, now).run();

  const jobId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'parse_file', ?, ?, ?, ?)`,
  ).bind(jobId, `parse_file:${filename}`, "upload", id, JSON.stringify({ importId: id }), now, now).run();
  const msg: JobMessage = { jobId, kind: "parse_file", target: id, config: { importId: id } };
  await c.env.LEAD_QUEUE.send(msg);

  return c.json({ id, filename, format, status: "uploaded", tab_count: tables.length }, 201);
});

// Task #3: operator isolation. Every read path filters by `created_by =
// c.var.email` so an allowlisted operator only sees their own imports.
// The Access JWT-derived email is the single source of truth; the
// special token "system" matches NULL-owner rows (legacy imports inserted
// before created_by was populated) so they remain reachable for cleanup.
function ownerFilterSql(email: string | null): { sql: string; binds: unknown[] } {
  if (!email) return { sql: "created_by IS NULL", binds: [] };
  return { sql: "(created_by = ? OR (created_by IS NULL AND ? = 'system'))", binds: [email, email] };
}

uploads.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const r = await c.env.DB
    .prepare(`SELECT id, filename, mime, size, status, format, entity, row_count, rows_imported, tab_count,
                     firms_created, firms_updated, leads_created, leads_updated,
                     queued_jobs, urls_found, error, created_by, created_at, updated_at
              FROM file_imports WHERE ${own.sql} ORDER BY created_at DESC LIMIT ?`)
    .bind(...own.binds, limit)
    .all();
  return c.json({ items: r.results ?? [] });
});

uploads.get("/:id", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT * FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const previewRaw = await c.env.SCRAPE_CACHE.get(`upload_preview:${id}`);
  const tabPreviewsRaw = await c.env.SCRAPE_CACHE.get(`upload_tab_previews:${id}`);
  const urlsRaw = await c.env.SCRAPE_CACHE.get(`upload_urls:${id}`);
  let preview: unknown = null, urls: string[] = [], tabPreviews: unknown = null;
  try { if (previewRaw) preview = JSON.parse(previewRaw); } catch { /* ignore */ }
  try { if (tabPreviewsRaw) tabPreviews = JSON.parse(tabPreviewsRaw); } catch { /* ignore */ }
  try { if (urlsRaw) urls = JSON.parse(urlsRaw) as string[]; } catch { /* ignore */ }
  let columnMap: unknown = null, summary: unknown = null;
  if (typeof row.column_map_json === "string") {
    try { columnMap = JSON.parse(row.column_map_json); } catch { /* ignore */ }
  }
  if (typeof row.summary_json === "string") {
    try { summary = JSON.parse(row.summary_json); } catch { /* ignore */ }
  }
  // Per-tab routing rows.
  const tabs = await c.env.DB.prepare(
    `SELECT id, tab_index, sheet_name, page_number, intent, intent_subkind, intent_confidence,
            row_count, column_map_json, map_confidence_json, rows_imported, rows_skipped, error
       FROM file_import_tabs WHERE import_id = ? ORDER BY tab_index`,
  ).bind(id).all<Record<string, unknown>>();
  const tabsOut = (tabs.results ?? []).map((t) => ({
    ...t,
    column_map: parseJsonObj(t.column_map_json),
    map_confidence: parseJsonObj(t.map_confidence_json),
  }));
  return c.json({
    ...row,
    column_map: columnMap,
    summary,
    preview,
    tab_previews: tabPreviews,
    tabs: tabsOut,
    urls,
  });
});

function parseJsonObj(s: unknown): Record<string, unknown> {
  if (typeof s !== "string") return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

uploads.post("/:id/confirm-map", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { column_map?: Record<string, string>; entity?: "firms" | "leads"; scrape_urls?: boolean | number;
        tabs?: Array<{ tab_index: number; intent?: string; intent_subkind?: string | null; column_map?: Record<string, string> }>; }
    | null;
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT id, status, entity FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ id: string; status: string; entity: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  // `?force=1` lets the operator re-confirm a mapping while a previous
  // import is still in flight. The previous queued/running job(s) for
  // this import are marked 'cancelled' (the worker checks job status
  // before persisting), counters are reset so progress reflects the
  // new run, and the import is re-enqueued. We still refuse force on
  // 'done' imports — those need to go through a fresh /rerun.
  const force = c.req.query("force") === "1" || c.req.query("force") === "true";
  if (row.status === "done") {
    return c.json({ error: "bad_state", status: row.status, message: "import already completed — use rerun" }, 409);
  }
  if (row.status === "importing" && !force) {
    return c.json({
      error: "bad_state",
      status: row.status,
      message: "import is in progress — re-confirm with ?force=1 to cancel the running job and re-map",
    }, 409);
  }
  if (row.status === "importing" && force) {
    await c.env.DB.prepare(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?
        WHERE target = ? AND kind = 'import_file' AND status IN ('queued','running')`,
    ).bind(new Date().toISOString(), id).run().catch(() => undefined);
    await c.env.DB.prepare(
      `UPDATE file_imports
          SET status = 'mapped',
              rows_imported = 0,
              firms_created = 0, firms_updated = 0,
              leads_created = 0, leads_updated = 0,
              queued_jobs = 0,
              error = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).bind(new Date().toISOString(), id).run().catch(() => undefined);
  }
  // Per-tab path (v2): persist each tab's overrides to file_import_tabs.
  if (Array.isArray(body?.tabs) && body!.tabs!.length) {
    for (const t of body!.tabs!) {
      const sets: string[] = []; const binds: unknown[] = [];
      if (t.intent) { sets.push("intent = ?"); binds.push(t.intent); }
      if (t.intent_subkind !== undefined) { sets.push("intent_subkind = ?"); binds.push(t.intent_subkind); }
      if (t.column_map) { sets.push("column_map_json = ?"); binds.push(JSON.stringify(t.column_map)); }
      if (!sets.length) continue;
      binds.push(id, t.tab_index);
      await c.env.DB.prepare(`UPDATE file_import_tabs SET ${sets.join(", ")} WHERE import_id = ? AND tab_index = ?`)
        .bind(...binds).run();
    }
  }
  // Legacy path (v1): single column_map → primary tab's map.
  const map = body?.column_map ?? null;
  const entity = body?.entity === "leads" ? "leads"
    : body?.entity === "firms" ? "firms"
    : (row.entity === "leads" ? "leads" : "firms");
  const su = body?.scrape_urls;
  const scrape = (su === false || su === 0) ? 0 : 1;
  const sets: string[] = ["entity = ?", "scrape_urls = ?", "error = NULL", "updated_at = ?"];
  const binds: unknown[] = [entity, scrape, new Date().toISOString()];
  if (map) { sets.unshift("column_map_json = ?"); binds.unshift(JSON.stringify(map)); }
  binds.push(id);
  await c.env.DB.prepare(`UPDATE file_imports SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', 'import_file', ?, ?, ?, ?)`,
    ).bind(jobId, `import_file:${id}`, "upload", id, JSON.stringify({ importId: id }), now, now).run();
    const msg: JobMessage = { jobId, kind: "import_file", target: id, config: { importId: id } };
    await c.env.LEAD_QUEUE.send(msg);
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE file_imports SET status = 'mapped', error = ?, updated_at = ? WHERE id = ?",
    ).bind(`enqueue_failed: ${(e as Error).message}`.slice(0, 500), new Date().toISOString(), id).run();
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 502);
  }
  await c.env.DB.prepare(
    "UPDATE file_imports SET status = 'importing', updated_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), id).run();
  return c.json({ ok: true, jobId }, 202);
});

// Save the current per-tab maps + intents as a reusable template, keyed on
// the file's source_signature so the next matching upload auto-applies it.
uploads.post("/:id/save-template", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string;
        tabs?: Array<{ tab_index: number; intent?: string; intent_subkind?: string | null; column_map?: Record<string, string> }>; }
    | null;
  const name = (body?.name ?? "").trim() || `template-${id.slice(0, 8)}`;
  // Validate ownership BEFORE any tab mutations so an unauthorized caller
  // cannot mutate another operator's `file_import_tabs` rows.
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT source_signature, format FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ source_signature: string | null; format: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.source_signature) return c.json({ error: "no_signature", message: "parse the file first" }, 409);
  // Persist any pending in-memory UI edits before snapshotting, so the
  // saved template reflects the operator's current state.
  if (Array.isArray(body?.tabs) && body!.tabs!.length) {
    for (const t of body!.tabs!) {
      const sets: string[] = []; const binds: unknown[] = [];
      if (t.intent) { sets.push("intent = ?"); binds.push(t.intent); }
      if (t.intent_subkind !== undefined) { sets.push("intent_subkind = ?"); binds.push(t.intent_subkind); }
      if (t.column_map) { sets.push("column_map_json = ?"); binds.push(JSON.stringify(t.column_map)); }
      if (!sets.length) continue;
      binds.push(id, t.tab_index);
      await c.env.DB.prepare(`UPDATE file_import_tabs SET ${sets.join(", ")} WHERE import_id = ? AND tab_index = ?`)
        .bind(...binds).run();
    }
  }
  const tabs = await c.env.DB.prepare(
    "SELECT sheet_name, intent, intent_subkind, column_map_json FROM file_import_tabs WHERE import_id = ? ORDER BY tab_index",
  ).bind(id).all<{ sheet_name: string | null; intent: string; intent_subkind: string | null; column_map_json: string | null }>();
  const tabsJson = (tabs.results ?? []).map((t) => ({
    sheet: t.sheet_name,
    intent: t.intent,
    intent_subkind: t.intent_subkind,
    column_map: parseJsonObj(t.column_map_json),
  }));
  const tplId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO import_templates (id, name, source_signature, format, tabs_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(tplId, name, row.source_signature, row.format, JSON.stringify(tabsJson),
         c.get("email") ?? null, new Date().toISOString()).run();
  return c.json({ id: tplId, name, source_signature: row.source_signature }, 201);
});

uploads.get("/:id/templates", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT source_signature FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ source_signature: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.source_signature) return c.json({ items: [] });
  const r = await c.env.DB.prepare(
    "SELECT id, name, format, use_count, last_used_at, created_at FROM import_templates WHERE source_signature = ? ORDER BY use_count DESC LIMIT 20",
  ).bind(row.source_signature).all();
  return c.json({ items: r.results ?? [] });
});

uploads.post("/:id/templates/:tplId/apply", async (c) => {
  const id = c.req.param("id");
  const tplId = c.req.param("tplId");
  // Validate the operator owns the target import BEFORE applying the
  // template — otherwise an unauthorized caller could mutate another
  // operator's `file_import_tabs` rows.
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const ownsImport = await c.env.DB
    .prepare(`SELECT 1 AS ok FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ ok: number }>();
  if (!ownsImport) return c.json({ error: "not_found" }, 404);
  const tpl = await c.env.DB.prepare("SELECT tabs_json FROM import_templates WHERE id = ?")
    .bind(tplId).first<{ tabs_json: string }>();
  if (!tpl) return c.json({ error: "template_not_found" }, 404);
  let overlay: Array<{ sheet?: string; intent?: string; intent_subkind?: string | null; column_map?: Record<string, string> }> = [];
  try { overlay = JSON.parse(tpl.tabs_json); } catch { return c.json({ error: "template_corrupt" }, 500); }
  const tabs = await c.env.DB.prepare(
    "SELECT id, tab_index, sheet_name, column_map_json FROM file_import_tabs WHERE import_id = ?",
  ).bind(id).all<{ id: string; tab_index: number; sheet_name: string | null; column_map_json: string | null }>();
  for (const t of (tabs.results ?? [])) {
    const match = overlay.find((o) => (o.sheet ?? "").toLowerCase() === (t.sheet_name ?? "").toLowerCase());
    if (!match) continue;
    const merged: Record<string, string> = parseJsonObj(t.column_map_json) as Record<string, string>;
    for (const [h, v] of Object.entries(match.column_map ?? {})) {
      if (h in merged) merged[h] = v;
    }
    await c.env.DB.prepare(
      `UPDATE file_import_tabs SET intent = COALESCE(?, intent), intent_subkind = ?, column_map_json = ? WHERE id = ?`,
    ).bind(match.intent ?? null, match.intent_subkind ?? null, JSON.stringify(merged), t.id).run();
  }
  await c.env.DB.prepare(
    "UPDATE import_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), tplId).run();
  return c.json({ ok: true });
});

uploads.post("/:id/rerun", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ skip_ocr?: boolean }>().catch(() => ({} as { skip_ocr?: boolean }));
  const skipOcr = body?.skip_ocr === true;
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT id, filename FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ id: string; filename: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  await c.env.DB
    .prepare("UPDATE file_imports SET status = 'uploaded', error = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  // skip_ocr=true tells parse.ts to honor cached vision results only —
  // it never re-invokes the vision model. Useful when the operator just
  // wants to re-classify or re-map without burning AI budget.
  const cfg = { importId: id, rerun: true, skip_ocr: skipOcr };
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'parse_file', ?, ?, ?, ?)`,
  ).bind(jobId, `parse_file:${row.filename}`, "upload", id, JSON.stringify(cfg), now, now).run();
  const msg: JobMessage = { jobId, kind: "parse_file", target: id, config: cfg };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ ok: true, jobId, skip_ocr: skipOcr }, 202);
});

// Task #3: status-gated retry. Unlike /rerun (which always re-parses from
// scratch), /retry only fires when the import is in a terminal-failure
// state and deterministically resumes from the correct stage by
// inspecting the most recent job row for this import:
//   - last job kind = 'parse_file'  → re-enqueue parse_file (status → 'uploaded')
//   - last job kind = 'import_file' → re-enqueue import_file (status → 'mapped')
// Failure status in `parse.ts` / `import.ts` is consistently 'error';
// 'cancelled' is honored if a future sweeper adopts that terminal value.
// Any other status returns 409 bad_state so the operator can't accidentally
// double-enqueue a running import.
uploads.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT id, filename, status FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ id: string; filename: string; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "error" && row.status !== "cancelled") {
    return c.json({ error: "bad_state", status: row.status, message: "retry only allowed on error/cancelled imports" }, 409);
  }
  // Deterministic stage selection: look up the most recent job for this
  // import and resume that exact stage. This is more robust than
  // inferring stage from `column_map_json` presence (which can persist
  // across reruns and would misroute parse-stage failures to import).
  const lastJob = await c.env.DB
    .prepare("SELECT kind FROM jobs WHERE target = ? AND kind IN ('parse_file','import_file') ORDER BY created_at DESC LIMIT 1")
    .bind(id)
    .first<{ kind: string }>();
  const kind: JobKind = lastJob?.kind === "import_file" ? "import_file" : "parse_file";
  const nextStatus = kind === "import_file" ? "mapped" : "uploaded";
  const priorStatus = row.status;
  // Insert the audit row + flip status FIRST, then attempt the queue
  // send. If the send throws we revert the import status back to its
  // prior terminal state and surface the failure, so the operator can
  // retry without the import being stuck in a stale 'uploaded'/'mapped'
  // limbo with no queued job.
  await c.env.DB
    .prepare("UPDATE file_imports SET status = ?, error = NULL, updated_at = ? WHERE id = ?")
    .bind(nextStatus, new Date().toISOString(), id)
    .run();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const cfg = { importId: id, retry: true };
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).bind(jobId, `${kind}:${row.filename}`, "upload", kind, id, JSON.stringify(cfg), now, now).run();
  try {
    const msg: JobMessage = { jobId, kind, target: id, config: cfg };
    await c.env.LEAD_QUEUE.send(msg);
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE file_imports SET status = ?, error = ?, updated_at = ? WHERE id = ?",
    ).bind(priorStatus, `retry_enqueue_failed: ${(e as Error).message}`.slice(0, 500),
           new Date().toISOString(), id).run();
    await c.env.DB.prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?")
      .bind((e as Error).message.slice(0, 500), jobId).run();
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 502);
  }
  return c.json({ ok: true, jobId, kind, status: nextStatus }, 202);
});

/** Dry-run import: project each tab's rows through its saved column_map
 *  (header → "firms.field"), then enumerate rows that would be created
 *  vs. updated and return a small sample of column-level diffs. Only
 *  inspects firms-intent tabs (the only entity with stable upsert keys). */
uploads.post("/:id/diff-preview", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB.prepare(
    `SELECT id, summary_json FROM file_imports WHERE id = ? AND ${own.sql}`,
  ).bind(id, ...own.binds).first<{ id: string; summary_json: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const rowsRaw = await c.env.SCRAPE_CACHE.get(`upload_rows:${id}`);
  const tabRows: Record<string, Array<Record<string, string>>> =
    rowsRaw ? JSON.parse(rowsRaw) : {};
  const summary = row.summary_json ? JSON.parse(row.summary_json) as { tabs?: Array<{ index: number; intent: string }> } : { tabs: [] };
  // Pull saved column_map per tab so source headers map to firms.* fields.
  const tabMaps = await c.env.DB.prepare(
    "SELECT tab_index, intent, column_map_json FROM file_import_tabs WHERE import_id = ?",
  ).bind(id).all<{ tab_index: number; intent: string; column_map_json: string | null }>();
  const mapByIdx = new Map<number, Record<string, string>>();
  for (const r of tabMaps.results ?? []) {
    try { mapByIdx.set(r.tab_index, r.column_map_json ? JSON.parse(r.column_map_json) as Record<string, string> : {}); }
    catch { mapByIdx.set(r.tab_index, {}); }
  }
  let wouldCreate = 0, wouldUpdate = 0;
  let rowsConsidered = 0, rowsWithDomain = 0, rowsExistingByDomain = 0;
  const samples: Array<{ tab: number; key: string; field: string; old: string | null; new: string }> = [];
  // Normalize a website/domain into a canonical host (no protocol, no path,
  // no port, no leading "www."). Returns "" when input cannot be normalized.
  const canonDomain = (raw: string): string => {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "";
    const noProto = s.replace(/^https?:\/\//, "");
    const host = noProto.split(/[/?#]/, 1)[0].split(":", 1)[0];
    return host.replace(/^www\./, "");
  };
  for (const t of summary.tabs ?? []) {
    if (t.intent !== "firms") continue;
    const colMap = mapByIdx.get(t.index) ?? {};
    const fieldToHeader: Record<string, string> = {};
    for (const [hdr, target] of Object.entries(colMap)) {
      if (!target || target === "__skip__") continue;
      const m = /^firms\.(.+)$/.exec(target);
      if (m && !fieldToHeader[m[1]]) fieldToHeader[m[1]] = hdr;
    }
    const rows = tabRows[String(t.index)] ?? [];
    for (const r of rows) {
      const proj: Record<string, string> = {};
      for (const [field, hdr] of Object.entries(fieldToHeader)) {
        proj[field] = String(r[hdr] ?? "").trim();
      }
      const domain = canonDomain(proj["website"] || proj["domain"] || "");
      const name = (proj["name"] || "").trim();
      if (!domain && !name) continue;
      rowsConsidered++;
      // Domain-driven matching ONLY when a domain is present. Anchored host
      // patterns avoid `LIKE '%%'` and substring false-positives.
      let existing: { id: string; name: string | null; website: string | null; hq_country_iso2: string | null } | null = null;
      if (domain) {
        rowsWithDomain++;
        existing = await c.env.DB.prepare(
          "SELECT id, name, website, hq_country_iso2 FROM firms " +
          "WHERE LOWER(website) LIKE ? OR LOWER(website) LIKE ? OR LOWER(website) LIKE ? OR LOWER(website) = ? LIMIT 1",
        ).bind(
          `%//${domain}/%`, `%//${domain}`, `%//www.${domain}%`, domain,
        ).first<{ id: string; name: string | null; website: string | null; hq_country_iso2: string | null }>();
        if (existing) rowsExistingByDomain++;
      } else if (name) {
        existing = await c.env.DB.prepare(
          "SELECT id, name, website, hq_country_iso2 FROM firms WHERE LOWER(name) = LOWER(?) LIMIT 1",
        ).bind(name).first<{ id: string; name: string | null; website: string | null; hq_country_iso2: string | null }>();
      }
      if (!existing) { wouldCreate++; continue; }
      wouldUpdate++;
      for (const field of ["name", "website", "hq_country_iso2"] as const) {
        const newVal = (proj[field] ?? "").trim();
        const oldVal = (existing as Record<string, string | null>)[field];
        if (newVal && newVal !== (oldVal ?? "") && samples.length < 10) {
          samples.push({ tab: t.index, key: name || domain, field, old: oldVal, new: newVal });
        }
      }
    }
  }
  // Acceptance: surface diff preview only when ≥80% of domain-bearing rows
  // already exist by domain. Eligibility flag lets the UI gate the action.
  const domainExistRatio = rowsWithDomain > 0 ? rowsExistingByDomain / rowsWithDomain : 0;
  const eligible = rowsWithDomain > 0 && domainExistRatio >= 0.8;
  return c.json({
    would_create_count: wouldCreate,
    would_update_count: wouldUpdate,
    sample_diffs: samples,
    rows_considered: rowsConsidered,
    rows_with_domain: rowsWithDomain,
    rows_existing_by_domain: rowsExistingByDomain,
    domain_exist_ratio: Number(domainExistRatio.toFixed(3)),
    threshold: 0.8,
    eligible,
  });
});

uploads.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const email = c.get("email") ?? null;
  const own = ownerFilterSql(email);
  const row = await c.env.DB
    .prepare(`SELECT r2_key FROM file_imports WHERE id = ? AND ${own.sql}`)
    .bind(id, ...own.binds)
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  try { await c.env.UPLOADS.delete(row.r2_key); } catch { /* best-effort */ }
  await c.env.SCRAPE_CACHE.delete(`upload_preview:${id}`).catch(() => undefined);
  await c.env.SCRAPE_CACHE.delete(`upload_tab_previews:${id}`).catch(() => undefined);
  await c.env.SCRAPE_CACHE.delete(`upload_urls:${id}`).catch(() => undefined);
  await c.env.SCRAPE_CACHE.delete(`upload_rows:${id}`).catch(() => undefined);
  await c.env.DB.prepare("DELETE FROM file_imports WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
