// /api/uploads — file upload + management surface used by the dashboard
// Import-file modal and the uploads.html page (Task #22).
//
// All routes sit under accessGuard (mounted in src/index.ts).
//   POST   /api/uploads                  multipart, ≤50 MB
//   GET    /api/uploads                  list
//   GET    /api/uploads/:id              detail (with map + 5-row preview)
//   POST   /api/uploads/:id/confirm-map  start the import phase
//   POST   /api/uploads/:id/rerun        re-enqueue parse_file
//   DELETE /api/uploads/:id              remove R2 object + row

import { Hono } from "hono";
import type { Env, JobMessage } from "../types";

export const uploads = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set(["csv", "tsv", "xlsx", "xls", "ods", "pdf"]);

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

  // Enqueue parse_file. We mirror the existing pattern of writing a jobs row
  // for queue audit + child-tracking, but the lifecycle of the import lives
  // on file_imports.
  const jobId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'parse_file', ?, ?, ?, ?)`,
  ).bind(jobId, `parse_file:${filename}`, "upload", id, JSON.stringify({ importId: id }), now, now).run();
  const msg: JobMessage = { jobId, kind: "parse_file", target: id, config: { importId: id } };
  await c.env.LEAD_QUEUE.send(msg);

  return c.json({ id, filename, size: file.size, status: "uploaded" }, 201);
});

uploads.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const r = await c.env.DB
    .prepare(`SELECT id, filename, mime, size, status, entity, row_count, rows_imported,
                     firms_created, firms_updated, leads_created, leads_updated,
                     queued_jobs, urls_found, error, created_by, created_at, updated_at
              FROM file_imports ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all();
  return c.json({ items: r.results ?? [] });
});

uploads.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM file_imports WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const previewRaw = await c.env.SCRAPE_CACHE.get(`upload_preview:${id}`);
  const urlsRaw = await c.env.SCRAPE_CACHE.get(`upload_urls:${id}`);
  let preview: unknown = null, urls: string[] = [];
  try { if (previewRaw) preview = JSON.parse(previewRaw); } catch { /* ignore */ }
  try { if (urlsRaw) urls = JSON.parse(urlsRaw) as string[]; } catch { /* ignore */ }
  let columnMap: unknown = null;
  if (typeof row.column_map_json === "string") {
    try { columnMap = JSON.parse(row.column_map_json); } catch { /* ignore */ }
  }
  return c.json({ ...row, column_map: columnMap, preview, urls });
});

uploads.post("/:id/confirm-map", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { column_map?: Record<string, string>; entity?: "firms" | "leads"; scrape_urls?: boolean | number }
    | null;
  const row = await c.env.DB.prepare("SELECT id, status, entity FROM file_imports WHERE id = ?").bind(id).first<{ id: string; status: string; entity: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "importing" || row.status === "done") {
    return c.json({ error: "bad_state", status: row.status }, 409);
  }
  const map = body?.column_map ?? {};
  // Honor an explicit body.entity, otherwise keep what the parse phase
  // inferred. Only fall back to "firms" if neither is set.
  const entity = body?.entity === "leads" ? "leads"
    : body?.entity === "firms" ? "firms"
    : (row.entity === "leads" ? "leads" : "firms");
  // Accept boolean OR 0/1 from clients. Treat undefined as enabled (default on).
  const su = body?.scrape_urls;
  const scrape = (su === false || su === 0) ? 0 : 1;
  // Persist the confirmed map first but leave status as 'mapped' until the
  // queue actually accepts the message. If the send fails we roll the row
  // back to 'mapped' (with an error string) so the user can retry instead
  // of being stuck in 'importing'.
  await c.env.DB.prepare(
    `UPDATE file_imports
       SET column_map_json = ?, entity = ?, scrape_urls = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).bind(JSON.stringify(map), entity, scrape, new Date().toISOString(), id).run();

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

uploads.post("/:id/rerun", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id, filename FROM file_imports WHERE id = ?").bind(id).first<{ id: string; filename: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  await c.env.DB
    .prepare("UPDATE file_imports SET status = 'uploaded', error = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'parse_file', ?, ?, ?, ?)`,
  ).bind(jobId, `parse_file:${row.filename}`, "upload", id, JSON.stringify({ importId: id, rerun: true }), now, now).run();
  const msg: JobMessage = { jobId, kind: "parse_file", target: id, config: { importId: id, rerun: true } };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ ok: true, jobId }, 202);
});

uploads.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT r2_key FROM file_imports WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  try { await c.env.UPLOADS.delete(row.r2_key); } catch { /* best-effort */ }
  await c.env.SCRAPE_CACHE.delete(`upload_preview:${id}`).catch(() => undefined);
  await c.env.SCRAPE_CACHE.delete(`upload_urls:${id}`).catch(() => undefined);
  await c.env.SCRAPE_CACHE.delete(`upload_rows:${id}`).catch(() => undefined);
  await c.env.DB.prepare("DELETE FROM file_imports WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
