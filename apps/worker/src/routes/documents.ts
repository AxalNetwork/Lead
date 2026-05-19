// Task #13: Document Intelligence routes.
//
// Surface:
//   POST   /api/documents/upload                multipart: one or more `file` parts
//                                               + optional target_entity_id / data_room_id
//                                               (folder upload = multiple files in one request)
//   GET    /api/documents                        list (owner-scoped)
//   GET    /api/documents/:id                   detail
//   GET    /api/documents/:id/preview           redacted first-page text (reader UI)
//   GET    /api/documents/:id/extractions       all extraction rows for a doc
//   PATCH  /api/documents/:id/allow-raw-text    flip the redaction-override flag (audited)
//   DELETE /api/documents/:id                   remove R2 object + row
//
// All routes mount behind accessGuard in index.ts. Scoping is per
// owner_email (Cloudflare Access JWT subject).

import { Hono } from "hono";
import type { Env } from "../types";
import { classifyDocument } from "../services/documents/classifier";
import { runExtractor } from "../services/documents/extractorRouter";
import { persistExtraction } from "../services/documents/persist";
import type { Sheet } from "../services/documents/extractors/financialModel";

export const documentsRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set(["pdf", "txt", "md", "html", "htm", "xlsx", "xls", "csv", "ods", "pptx", "ppt", "docx", "doc"]);

function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "document";
}
function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function extractText(bytes: ArrayBuffer, ext: string, mime: string): Promise<{ text: string; sheets?: Sheet[]; pageCount?: number }> {
  // PDF: try pdfjs-dist for text. Workers lack canvas so we use text-only.
  if (ext === "pdf" || mime === "application/pdf") {
    try {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
      const loadingTask = (pdfjsLib as { getDocument: (opts: { data: Uint8Array; disableWorker: boolean }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> }> } })
        .getDocument({ data: new Uint8Array(bytes), disableWorker: true });
      const doc = await loadingTask.promise;
      const pageCount = doc.numPages;
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(pageCount, 50); i++) {
        const page = await doc.getPage(i);
        const c = await page.getTextContent();
        pages.push(c.items.map((it) => it.str ?? "").join(" "));
      }
      return { text: pages.join("\n\n"), pageCount };
    } catch (e) {
      console.warn("pdf text extraction failed", (e as Error).message);
      return { text: "" };
    }
  }
  // XLSX / CSV / ODS: parse sheets.
  if (["xlsx", "xls", "ods", "csv"].includes(ext)) {
    try {
      const XLSX = await import("xlsx" as string);
      const wb = (XLSX as { read: (data: Uint8Array, opts: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> } })
        .read(new Uint8Array(bytes), { type: "array" });
      const sheets: Sheet[] = [];
      const textChunks: string[] = [];
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const rowsRaw = (XLSX as { utils: { sheet_to_json: (s: unknown, opts: { header: number | string; defval: null }) => unknown[] } })
          .utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
        if (!rowsRaw.length) continue;
        const headers = (rowsRaw[0] as unknown[]).map((h) => String(h ?? ""));
        const rows = rowsRaw.slice(1).map((r) => {
          const obj: Record<string, string | number | null> = {};
          headers.forEach((h, i) => {
            const v = (r as unknown[])[i];
            obj[h] = v == null ? null : (typeof v === "number" ? v : String(v));
          });
          return obj;
        });
        sheets.push({ name, headers, rows });
        textChunks.push(`Sheet: ${name}\n${headers.join("\t")}\n${rows.slice(0, 20).map((r) => headers.map((h) => String(r[h] ?? "")).join("\t")).join("\n")}`);
      }
      return { text: textChunks.join("\n\n"), sheets, pageCount: sheets.length };
    } catch (e) {
      console.warn("xlsx parse failed", (e as Error).message);
      return { text: "" };
    }
  }
  // Plain text / html / md.
  if (["txt", "md", "html", "htm"].includes(ext)) {
    try {
      const text = new TextDecoder().decode(bytes);
      // Strip HTML tags if html.
      if (ext === "html" || ext === "htm") {
        return { text: text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
      }
      return { text };
    } catch { return { text: "" }; }
  }
  // PPTX / DOCX / other office formats: best-effort, return empty (extractor falls through to unknown).
  return { text: "" };
}

interface UploadResultItem {
  ok: boolean;
  id?: string;
  filename: string;
  size?: number;
  sha256?: string;
  detected_kind?: string;
  classifier_confidence?: number;
  extraction_status?: string;
  extraction_error?: string | null;
  error?: string;
}

async function processOneFile(
  c: { env: Env },
  email: string,
  file: { name?: string; size?: number; type?: string; arrayBuffer: () => Promise<ArrayBuffer> },
  opts: { targetEntityId: string | null; dataRoomId: string | null; allowRawText: boolean },
): Promise<UploadResultItem> {
  const filename = safeName(file.name || "document");
  const ext = extOf(filename);
  if (typeof file.size !== "number") return { ok: false, filename, error: "bad_file" };
  if (file.size > MAX_BYTES) return { ok: false, filename, error: "too_large" };
  if (!ALLOWED_EXT.has(ext)) return { ok: false, filename, error: "unsupported_type" };

  const bytes = await file.arrayBuffer();
  const sha = await sha256Hex(bytes);
  const id = crypto.randomUUID();
  // Content-addressed R2 key (sha256-prefixed). Multiple documents with
  // the same bytes share the underlying blob; the per-document id still
  // gives each row a unique handle for owner-scoping and audit.
  const r2Key = `documents/sha256/${sha}/${filename}`;
  const mime = file.type || null;

  await c.env.UPLOADS.put(r2Key, bytes, {
    httpMetadata: { contentType: mime || "application/octet-stream" },
    customMetadata: { document_id: id, filename, owner_email: email },
  });

  const now = new Date().toISOString();
  // Per spec: both statuses start at 'pending'; transition to 'running'
  // immediately before extraction kicks off.
  await c.env.DB.prepare(
    `INSERT INTO documents (
       id, owner_email, target_entity_id, filename, mime, size_bytes, r2_key, sha256,
       ocr_status, extraction_status, allow_raw_text, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)`,
  ).bind(id, email, opts.targetEntityId, filename, mime, file.size, r2Key, sha, opts.allowRawText ? 1 : 0, now, now).run();

  // Upload-time raw-text override is a sensitive policy decision: audit it
  // here in addition to PATCH /:id/allow-raw-text (which only fires on
  // post-upload flips).
  if (opts.allowRawText) {
    console.log(JSON.stringify({
      event: "document.allow_raw_text",
      origin: "upload",
      document_id: id, owner: email, filename, allow: true,
    }));
  }

  await c.env.DB.prepare(
    `UPDATE documents SET extraction_status = 'running', updated_at = ? WHERE id = ?`,
  ).bind(new Date().toISOString(), id).run();

  let detected_kind: string = "unknown";
  let confidence = 0;
  let extractionError: string | null = null;
  try {
    const { text, sheets, pageCount } = await extractText(bytes, ext, mime ?? "");
    const cls = classifyDocument({ filename, mime, sampleText: text.slice(0, 4000) });
    detected_kind = cls.kind;
    confidence = cls.confidence;
    const envelope = runExtractor({ kind: cls.kind, text, sheets, allowRawText: opts.allowRawText });
    await persistExtraction(c.env, id, opts.targetEntityId, `r2://${r2Key}`, envelope);
    // Reader-UI preview: store ≤4000 chars of the (PII-aware) extracted
    // text. When allow_raw_text=0 we run the redactor here too, so the
    // preview never exposes PII even if the per-extractor envelope was
    // raw. When allow_raw_text=1 the raw text is stored — same policy
    // surface that's already audit-logged at upload time.
    const { redactPii } = await import("../services/documents/pii");
    const previewText = (opts.allowRawText ? text : redactPii(text).text).slice(0, 4000);
    await c.env.DB.prepare(
      `UPDATE documents SET detected_kind = ?, classifier_confidence = ?, ocr_status = 'done',
         extraction_status = 'done', page_count = ?, first_page_text = ?, updated_at = ? WHERE id = ?`,
    ).bind(detected_kind, confidence, pageCount ?? null, previewText, new Date().toISOString(), id).run();
  } catch (e) {
    extractionError = (e as Error).message.slice(0, 500);
    console.warn("document extraction failed", id, extractionError);
    await c.env.DB.prepare(
      `UPDATE documents SET extraction_status = 'error', extraction_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(extractionError, new Date().toISOString(), id).run();
  }

  if (opts.dataRoomId) {
    const room = await c.env.DB.prepare(
      `SELECT id FROM document_data_rooms WHERE id = ? AND owner_email = ?`,
    ).bind(opts.dataRoomId, email).first();
    if (room) {
      const { categorizeForDataRoom } = await import("../services/documents/persist");
      const category = categorizeForDataRoom(detected_kind, filename);
      try {
        await c.env.DB.prepare(
          `INSERT INTO data_room_documents (id, data_room_id, document_id, category) VALUES (?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), opts.dataRoomId, id, category).run();
      } catch (e) { console.warn("data-room auto-add failed", (e as Error).message); }
    } else {
      console.warn("data-room auto-add skipped: room not owned by caller", opts.dataRoomId, email);
    }
  }

  return {
    ok: true, id, filename, size: file.size, sha256: sha,
    detected_kind, classifier_confidence: confidence,
    extraction_status: extractionError ? "error" : "done",
    extraction_error: extractionError,
  };
}

documentsRoute.post("/upload", async (c) => {
  const email = c.get("email");
  let form: FormData;
  try { form = await c.req.formData(); }
  catch { return c.json({ error: "bad_request", message: "expected multipart/form-data" }, 400); }

  // Folder upload = multiple `file` parts in one multipart request. Each
  // is processed independently; per-file failures don't fail the batch.
  const files = form.getAll("file").filter(
    (f) => f && typeof f === "object" && "arrayBuffer" in (f as object),
  ) as unknown as Array<{ name?: string; size?: number; type?: string; arrayBuffer: () => Promise<ArrayBuffer> }>;
  if (!files.length) return c.json({ error: "bad_request", message: "at least one `file` field required" }, 400);
  if (files.length > 50) return c.json({ error: "too_many_files", message: "max 50 files per request" }, 413);

  const opts = {
    targetEntityId: (form.get("target_entity_id") as string | null) || null,
    dataRoomId: (form.get("data_room_id") as string | null) || null,
    allowRawText: (form.get("allow_raw_text") as string | null) === "1",
  };

  const results: UploadResultItem[] = [];
  for (const f of files) {
    try { results.push(await processOneFile(c, email, f, opts)); }
    catch (e) { results.push({ ok: false, filename: safeName(f.name || "document"), error: (e as Error).message.slice(0, 200) }); }
  }
  const okCount = results.filter((r) => r.ok).length;
  // Single-file shape preserved for backwards compat when only one file was sent.
  if (results.length === 1 && results[0].ok) {
    const r = results[0];
    return c.json({
      id: r.id, filename: r.filename, size: r.size, sha256: r.sha256,
      detected_kind: r.detected_kind, classifier_confidence: r.classifier_confidence,
      extraction_status: r.extraction_status, extraction_error: r.extraction_error,
      results,
    }, 201);
  }
  return c.json({ uploaded: okCount, total: results.length, results }, okCount > 0 ? 201 : 400);
});

documentsRoute.get("/", async (c) => {
  const email = c.get("email");
  const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
  const rows = await c.env.DB.prepare(
    `SELECT id, filename, mime, size_bytes, detected_kind, classifier_confidence,
            extraction_status, extraction_error, target_entity_id, page_count, created_at
       FROM documents WHERE owner_email = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(email, limit).all();
  return c.json({ documents: rows.results ?? [] });
});

documentsRoute.get("/:id", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT * FROM documents WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ document: row });
});

// Reader-pane preview: returns the redacted first-page text captured
// at extraction time. Owner-scoped. Powers the center pane in the
// data-room reader UI (Task #13 step 8).
documentsRoute.get("/:id/preview", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, filename, mime, detected_kind, page_count, allow_raw_text, first_page_text
       FROM documents WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first<{
    id: string; filename: string; mime: string | null; detected_kind: string | null;
    page_count: number | null; allow_raw_text: number; first_page_text: string | null;
  }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({
    document_id: row.id,
    filename: row.filename,
    mime: row.mime,
    detected_kind: row.detected_kind,
    page_count: row.page_count,
    redacted: row.allow_raw_text === 0,
    first_page_text: row.first_page_text || "",
    truncated: (row.first_page_text || "").length >= 4000,
  });
});

documentsRoute.get("/:id/extractions", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const doc = await c.env.DB.prepare(`SELECT id FROM documents WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!doc) return c.json({ error: "not_found" }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, extractor_name, extractor_version, confidence, payload_json,
            redaction_applied, redaction_counts_json, warnings_json, created_at
       FROM document_extractions WHERE document_id = ? ORDER BY created_at DESC`,
  ).bind(id).all();
  const extractions = (rows.results ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    payload: r.payload_json ? JSON.parse(r.payload_json as string) : null,
    redaction_counts: r.redaction_counts_json ? JSON.parse(r.redaction_counts_json as string) : null,
    warnings: r.warnings_json ? JSON.parse(r.warnings_json as string) : [],
  }));
  return c.json({ document_id: id, extractions });
});

documentsRoute.patch("/:id/allow-raw-text", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { allow?: boolean };
  const allow = body.allow === true;
  const doc = await c.env.DB.prepare(`SELECT id FROM documents WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!doc) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(`UPDATE documents SET allow_raw_text = ?, updated_at = ? WHERE id = ?`)
    .bind(allow ? 1 : 0, new Date().toISOString(), id).run();
  // Audit log
  console.log(JSON.stringify({ event: "document.allow_raw_text", document_id: id, owner: email, allow }));
  return c.json({ id, allow_raw_text: allow });
});

documentsRoute.delete("/:id", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT r2_key FROM documents WHERE id = ? AND owner_email = ?`).bind(id, email).first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  try { await c.env.UPLOADS.delete(row.r2_key); } catch { /* ignore */ }
  await c.env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});
