// Task #3: /api/uploads/csv* — spec-conforming CSV-only upload surface.
//
// Backed by the new `csv_imports` table (migration 332). Every route is
// operator-scoped by `user_email` from the Cloudflare Access JWT
// (populated in c.var.email by accessGuard). Coexists with the
// pre-existing /api/uploads/* multi-format surface (backed by
// `file_imports`) — the dashboard's CSV-typed callers address this
// router; other formats stay on the legacy surface.
//
// Routes:
//   POST   /api/uploads/csv          multipart, CSV-only, ≤50 MB
//   GET    /api/uploads/csv          list operator's imports (paginated)
//   GET    /api/uploads/csv/:id      full detail (errors, detected map, progress)
//   POST   /api/uploads/csv/:id/retry  re-enqueue when failed/cancelled

import { Hono } from "hono";
import type { Env, CsvImportEnvelopeMessage } from "../types";

export const uploadsCsv = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const MAX_BYTES = 50 * 1024 * 1024;
const CSV_MIMES = new Set([
  "text/csv", "text/plain", "application/csv",
  "application/vnd.ms-excel", // Excel exports CSV as this in some browsers
  "application/octet-stream", // some browsers strip type; we sniff by extension
]);

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "upload.csv";
}

uploadsCsv.post("/", async (c) => {
  const email = c.get("email");
  if (!email) return c.json({ error: "unauthorized" }, 401);
  let form: FormData;
  try { form = await c.req.formData(); }
  catch { return c.json({ error: "bad_request", message: "expected multipart/form-data" }, 400); }
  const f = form.get("file") as unknown as { name?: string; size?: number; type?: string; stream: () => ReadableStream } | null;
  if (!f || typeof f !== "object" || typeof f.size !== "number" || typeof f.stream !== "function") {
    return c.json({ error: "bad_request", message: "file field required" }, 400);
  }
  if (f.size > MAX_BYTES) return c.json({ error: "too_large", message: "max 50 MB" }, 413);
  const filename = safeFilename(f.name || "upload.csv");
  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? "").toLowerCase();
  const mime = (f.type || "").toLowerCase();
  // Accept by EITHER mime or extension; the multipart layer is permissive.
  if (!CSV_MIMES.has(mime) && ext !== "csv" && ext !== "tsv") {
    return c.json({ error: "unsupported_type", message: "CSV only", mime, ext }, 415);
  }
  if (!c.env.IMPORTS) return c.json({ error: "misconfigured", message: "IMPORTS bucket not bound" }, 500);
  const importId = crypto.randomUUID();
  const r2Key = `csv-imports/${importId}.csv`;
  await c.env.IMPORTS.put(r2Key, f.stream(), {
    httpMetadata: { contentType: "text/csv" },
  });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO csv_imports (id, user_email, filename, size_bytes, r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(importId, email, filename, f.size, r2Key, now, now).run();

  const jobId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'csv_import', ?, ?, ?, ?)`,
  ).bind(jobId, `csv_import:${filename}`, "csv_import", importId, JSON.stringify({ importId }), now, now).run();
  try {
    // Task #3 spec envelope: {type:'csv_import', import_id}. The queue
    // dispatcher in index.ts recognizes this shape and synthesizes the
    // JobMessage internally so the audit trail stays consistent.
    const msg: CsvImportEnvelopeMessage = { type: "csv_import", import_id: importId };
    await c.env.LEAD_QUEUE.send(msg);
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE csv_imports SET status = 'failed', error_log_json = ?, updated_at = ? WHERE id = ?",
    ).bind(JSON.stringify({ errors: [{ row_index: -1, error: `enqueue_failed: ${(e as Error).message}`.slice(0, 500) }] }),
            new Date().toISOString(), importId).run();
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 502);
  }
  return c.json({ import_id: importId, status: "queued" }, 201);
});

uploadsCsv.get("/", async (c) => {
  const email = c.get("email");
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const r = await c.env.DB.prepare(
    `SELECT id, filename, size_bytes, status, total_rows, processed_rows,
            created_entities, updated_entities, created_at, updated_at, completed_at
       FROM csv_imports WHERE user_email = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(email, limit).all();
  return c.json({ items: r.results ?? [] });
});

uploadsCsv.get("/:id", async (c) => {
  const email = c.get("email");
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM csv_imports WHERE id = ? AND user_email = ?",
  ).bind(id, email).first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  let detected_columns: unknown = null;
  let error_log: unknown = null;
  if (typeof row.detected_columns_json === "string") {
    try { detected_columns = JSON.parse(row.detected_columns_json); } catch { /* keep null */ }
  }
  if (typeof row.error_log_json === "string") {
    try { error_log = JSON.parse(row.error_log_json); } catch { /* keep null */ }
  }
  return c.json({ ...row, detected_columns, error_log });
});

uploadsCsv.post("/:id/retry", async (c) => {
  const email = c.get("email");
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT id, filename, status FROM csv_imports WHERE id = ? AND user_email = ?",
  ).bind(id, email).first<{ id: string; filename: string; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "failed" && row.status !== "cancelled") {
    return c.json({ error: "bad_state", status: row.status, message: "retry only allowed on failed/cancelled imports" }, 409);
  }
  const priorStatus = row.status;
  await c.env.DB.prepare(
    "UPDATE csv_imports SET status = 'queued', processed_rows = 0, error_log_json = NULL, updated_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), id).run();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'csv_import', ?, ?, ?, ?)`,
  ).bind(jobId, `csv_import:retry:${row.filename}`, "csv_import", id, JSON.stringify({ importId: id, retry: true }), now, now).run();
  try {
    const msg: CsvImportEnvelopeMessage = { type: "csv_import", import_id: id };
    await c.env.LEAD_QUEUE.send(msg);
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE csv_imports SET status = ?, error_log_json = ?, updated_at = ? WHERE id = ?",
    ).bind(priorStatus,
            JSON.stringify({ errors: [{ row_index: -1, error: `retry_enqueue_failed: ${(e as Error).message}`.slice(0, 500) }] }),
            new Date().toISOString(), id).run();
    await c.env.DB.prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?")
      .bind((e as Error).message.slice(0, 500), jobId).run();
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 502);
  }
  return c.json({ ok: true, import_id: id, jobId, status: "queued" }, 202);
});
