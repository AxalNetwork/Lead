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
import { streamFileFieldToR2 } from "../imports/multipart_stream";

export const uploadsCsv = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const MAX_BYTES = 50 * 1024 * 1024;

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "upload.csv";
}

uploadsCsv.post("/", async (c) => {
  const email = c.get("email");
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const ct = c.req.header("content-type") ?? "";
  if (!c.env.IMPORTS) return c.json({ error: "misconfigured", message: "IMPORTS bucket not bound" }, 500);
  const importId = crypto.randomUUID();
  const r2Key = `csv-imports/${importId}.csv`;

  // Task #3 spec: "Stream, never buffer." We avoid c.req.formData() —
  // that materializes every multipart part in memory and would blow the
  // 128 MB Worker isolate cap on 50 MB uploads. Instead we use a
  // streaming multipart parser (streamFileFieldToR2) that pipes the
  // `file` field's bytes straight into R2.put as a ReadableStream.
  //
  // Two transport shapes are accepted:
  //  1. multipart/form-data (browser uploads via <input type="file">)
  //  2. raw body (programmatic uploads — content-type:text/csv) where
  //     filename comes from the X-Filename header.
  let filename = "upload.csv";
  let totalBytes = 0;
  try {
    if (ct.toLowerCase().startsWith("multipart/form-data")) {
      const field = streamFileFieldToR2(c.req.raw, "file");
      // Tee the inbound stream so we can both (a) put to R2 and
      // (b) enforce the 50 MB cap mid-stream. R2.put is happy with a
      // ReadableStream of unknown length.
      const [a, b] = field.stream.tee();
      // Cap enforcement runs in parallel; if exceeded we abort.
      let aborted = false;
      const capPromise = (async () => {
        const reader = b.getReader();
        let running = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          running += value.byteLength;
          if (running > MAX_BYTES) {
            aborted = true;
            try { reader.cancel(); } catch { /* noop */ }
            break;
          }
        }
      })();
      await c.env.IMPORTS.put(r2Key, a, { httpMetadata: { contentType: "text/csv" } });
      await capPromise;
      const meta = await field.done;
      if (aborted || meta.size > MAX_BYTES) {
        try { await c.env.IMPORTS.delete(r2Key); } catch { /* noop */ }
        return c.json({ error: "too_large", message: "max 50 MB" }, 413);
      }
      filename = safeFilename(field.filename || "upload.csv");
      totalBytes = meta.size;
    } else {
      // Raw-body path.
      filename = safeFilename(c.req.header("x-filename") || "upload.csv");
      const body = c.req.raw.body;
      if (!body) return c.json({ error: "bad_request", message: "empty body" }, 400);
      const [a, b] = body.tee();
      let aborted = false;
      let running = 0;
      const capPromise = (async () => {
        const reader = b.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          running += value.byteLength;
          if (running > MAX_BYTES) { aborted = true; try { reader.cancel(); } catch { /* noop */ } break; }
        }
      })();
      await c.env.IMPORTS.put(r2Key, a, { httpMetadata: { contentType: "text/csv" } });
      await capPromise;
      if (aborted) {
        try { await c.env.IMPORTS.delete(r2Key); } catch { /* noop */ }
        return c.json({ error: "too_large", message: "max 50 MB" }, 413);
      }
      totalBytes = running;
    }
  } catch (e) {
    try { await c.env.IMPORTS.delete(r2Key); } catch { /* noop */ }
    return c.json({ error: "bad_request", message: `upload_stream_failed: ${(e as Error).message}` }, 400);
  }

  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? "").toLowerCase();
  if (ext && ext !== "csv" && ext !== "tsv") {
    try { await c.env.IMPORTS.delete(r2Key); } catch { /* noop */ }
    return c.json({ error: "unsupported_type", message: "CSV only", ext }, 415);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO csv_imports (id, user_email, filename, size_bytes, r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(importId, email, filename, totalBytes, r2Key, now, now).run();

  // Task #3: do NOT pre-create a `jobs` row here. The queue consumer
  // (index.ts envelope dispatcher) owns the jobs-row lifecycle for
  // csv_import envelopes — it inserts a row and immediately runs it, so
  // an upfront insert here would leave an orphan queued row in
  // operational dashboards.
  try {
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
  // Task #3: jobs-row creation is owned by the queue envelope dispatcher
  // (index.ts) — see the matching comment in POST /. Don't pre-create
  // here, or every retry leaves an orphan queued jobs row.
  try {
    const msg: CsvImportEnvelopeMessage = { type: "csv_import", import_id: id };
    await c.env.LEAD_QUEUE.send(msg);
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE csv_imports SET status = ?, error_log_json = ?, updated_at = ? WHERE id = ?",
    ).bind(priorStatus,
            JSON.stringify({ errors: [{ row_index: -1, error: `retry_enqueue_failed: ${(e as Error).message}`.slice(0, 500) }] }),
            new Date().toISOString(), id).run();
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 502);
  }
  return c.json({ ok: true, import_id: id, status: "queued" }, 202);
});
