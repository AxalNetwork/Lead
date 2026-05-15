// parse_file queue consumer. Loads the uploaded file from R2, picks a parser
// by mime/extension, persists a 5-row preview + extracted-URL list to KV,
// auto-maps headers, and flips file_imports.status to 'mapped'.

import type { Env } from "../types";
import { parseCsv } from "./csv";
import { parseSpreadsheet } from "./xlsx_parser";
import { parsePdfTables } from "./pdf_parser";
import { autoMapHeaders, inferEntity } from "./auto_map";
import { extractUrlsFromRows } from "./url_extract";
import type { ParsedTable } from "./csv";

export async function processParseFile(env: Env, importId: string): Promise<void> {
  const row = await env.DB
    .prepare("SELECT * FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<{ id: string; filename: string; mime: string | null; r2_key: string }>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);

  await env.DB
    .prepare("UPDATE file_imports SET status = 'parsing', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), importId)
    .run();

  try {
    const obj = await env.UPLOADS.get(row.r2_key);
    if (!obj) throw new Error("upload_object_missing");
    const bytes = await obj.arrayBuffer();
    const ext = extOf(row.filename);
    const tables = await parseByKind(bytes, ext, row.mime);
    if (!tables.length || !tables[0].headers.length) throw new Error("no_table_found");
    // Use the largest table when multiple are detected (PDFs).
    tables.sort((a, b) => b.rows.length - a.rows.length);
    const primary = tables[0];

    const map = autoMapHeaders(primary.headers);
    const entity = inferEntity(map);
    const urls = extractUrlsFromRows(primary.rows);
    const preview = primary.rows.slice(0, 5);

    await env.SCRAPE_CACHE.put(`upload_preview:${importId}`, JSON.stringify({
      headers: primary.headers,
      rows: preview,
      tables_found: tables.length,
    }), { expirationTtl: 60 * 60 * 24 * 7 });
    await env.SCRAPE_CACHE.put(`upload_urls:${importId}`, JSON.stringify(urls), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    // NOTE: We deliberately do NOT cache the full parsed rows here. KV values
    // are capped at 25 MB and a 10k-row sheet can easily exceed that. The
    // import phase re-loads bytes from R2 and re-parses, which is bounded
    // memory and survives worker restarts.

    await env.DB.prepare(
      `UPDATE file_imports
         SET status = 'mapped',
             entity = ?,
             row_count = ?,
             urls_found = ?,
             column_map_json = ?,
             updated_at = ?
       WHERE id = ?`,
    ).bind(
      entity,
      primary.rows.length,
      urls.length,
      JSON.stringify(serializeMap(map)),
      new Date().toISOString(),
      importId,
    ).run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String((e as Error).message).slice(0, 500), new Date().toISOString(), importId).run();
    throw e;
  }
}

function serializeMap(map: Record<string, ReturnType<typeof autoMapHeaders>[string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v ? `${v.entity}.${v.field}` : "__skip__";
  }
  return out;
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

async function parseByKind(bytes: ArrayBuffer, ext: string, mime: string | null): Promise<ParsedTable[]> {
  const m = (mime || "").toLowerCase();
  if (ext === "pdf" || m.includes("pdf")) return parsePdfTables(bytes);
  if (ext === "csv" || m.includes("text/csv")) {
    return [parseCsv(new TextDecoder().decode(bytes))];
  }
  if (ext === "tsv") {
    return [parseCsv(new TextDecoder().decode(bytes), "\t")];
  }
  // Default: treat as a SheetJS-readable workbook (xlsx/xls/ods/csv).
  return [await parseSpreadsheet(bytes)];
}
