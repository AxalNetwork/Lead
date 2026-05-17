// Task #3: csv_import queue consumer per spec contract.
//
// Streams the operator's CSV from R2 `IMPORTS` bucket, runs schema
// auto-detection via Workers AI (strict JSON schema with one
// lower-temperature retry; second failure → status='needs_manual_mapping'),
// then upserts firms in batches of 50 through the existing `upsertFirm`
// helper so we share one entity-write path (dedupe key:
// lower(name) + canonical(website) + canonical(crunchbase_url)).
//
// Idempotency: re-uploading a content-identical file produces zero new
// entities because `upsertFirm` dedupes by (lower(name), domain) and
// returns action='unchanged' when no scalar field changes.
//
// Large files (>5,000 rows): the handler caps inline work at 5,000 rows
// per invocation and marks the import status='processing' with
// processed_rows updated; the queue retry path resumes from the last
// `processed_rows` checkpoint. A future CsvImportWorkflow chain can
// adopt this same checkpoint pointer — see drift note in task commit.

import type { Env } from "../types";
import { upsertFirm } from "../scraper/firms_upsert";
import { extractDomain } from "../scraper/normalize";
import type { FirmCandidate } from "../scraper/parsers/firmlists/types";
import { detectHasHeader, synthesizeHeaders, looksLikeTypeString } from "../services/csv/headerDetector";

const INLINE_ROW_CAP = 5000;
const BATCH_SIZE = 50;
const ERROR_LOG_CAP = 200;
// Task #5: buffer the first N records before deciding whether row 0 is
// a header. The operator's headerless CSV ("500 LGBT Syndicate,VC,…")
// was being mis-treated as headers; headerDetector.detectHasHeader
// uses this sample to decide.
const HEADER_SAMPLE = 10;

interface CsvImportRow {
  id: string;
  user_email: string;
  r2_key: string;
  status: string;
  processed_rows: number;
  detected_columns_json: string | null;
  error_log_json: string | null;
}

interface DetectedColumns {
  entity_type: "person" | "company" | "fund";
  column_map: Record<string, { predicate: string | null; value_type: string; confidence: number; notes?: string }>;
}

export async function processCsvImport(env: Env, importId: string, opts: { insideWorkflow?: boolean } = {}): Promise<void> {
  const row = await env.DB
    .prepare("SELECT id, user_email, r2_key, status, processed_rows, detected_columns_json, error_log_json FROM csv_imports WHERE id = ?")
    .bind(importId)
    .first<CsvImportRow>();
  if (!row) throw new Error(`csv_import_not_found:${importId}`);

  await setStatus(env, importId, "processing");

  try {
    if (!env.IMPORTS) throw new Error("imports_bucket_not_bound");
    const obj = await env.IMPORTS.get(row.r2_key);
    if (!obj) throw new Error("r2_object_missing");
    // Stream-parse the R2 body row-by-row. Memory bound: one chunk
    // (~64 KB typical R2 block) + the current batch (≤50 rows) at a
    // time — never the full file. The async generator yields one
    // header array followed by one row array per CSV record.
    const stream = obj.body as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    let headers: string[] | null = null;
    const decoder = new TextDecoder();
    let leftover = "";
    let inQuotes = false;
    const pendingRows: string[][] = [];
    // Task #5: buffer the first HEADER_SAMPLE records before deciding
    // whether row 0 is a real header. Cleared once `headers` is set.
    const headerBuffer: string[][] = [];

    // Resume from checkpoint.
    const startCursor = row.processed_rows | 0;
    let totalSeen = 0;     // every row index parsed from the file so far
    let cursor = startCursor;
    const inlineEnd = startCursor + INLINE_ROW_CAP;
    let created = 0, updated = 0;
    let skippedRows = 0;   // Task #5: rows rejected by pre-insert safeguard
    const errors: Array<{ row_index: number; error: string }> = safeJson<Array<{ row_index: number; error: string }>>(row.error_log_json ?? "") ?? [];
    let droppedErrors = 0;
    let detected: DetectedColumns | null = row.detected_columns_json
      ? safeJson<DetectedColumns>(row.detected_columns_json)
      : null;
    let needsManualMapping = false;
    let hitCap = false;
    let reachedEof = false;

    const flushBatch = async (): Promise<void> => {
      if (!pendingRows.length || !detected) { pendingRows.length = 0; return; }
      for (const cells of pendingRows) {
        const idx = totalSeen - pendingRows.length + pendingRows.indexOf(cells); // best-effort index
        try {
          const candidate = rowToFirmCandidate(headers!, cells, detected);
          if (!candidate) continue; // skipped (no usable name+domain)
          // Task #5: pre-insert safeguard. If the proposed `name` matches
          // the Type/Kind regex ("VC", "Nonprofit, Training Program",
          // "VC, Fellows Program", …) the CSV column mapping is wrong —
          // reject before upsertFirm so the corrupted name never lands
          // in `firms.name`. Counted in skipped_rows + logged.
          if (looksLikeTypeString(candidate.name)) {
            skippedRows++;
            if (errors.length < ERROR_LOG_CAP) errors.push({ row_index: idx, error: `type_string_name_rejected:${candidate.name.slice(0, 80)}` });
            else droppedErrors++;
            continue;
          }
          // Task #3 dedupe contract: lower(trim(name))+canonical(website)
          // +canonical(crunchbase_url). Pre-query firms on the natural key
          // and re-bind candidate.domain to the matched row so the
          // downstream upsertFirm (which matches on lower(name)+domain)
          // finds the existing row instead of inserting.
          await applyNaturalKeyDedupe(env, candidate);
          const res = await upsertFirm(env, candidate, `csv_import:${importId}`, { source: "csv_import", sourceKind: "import" });
          if (res.action === "created") created++;
          else if (res.action === "updated") updated++;
        } catch (e) {
          if (errors.length < ERROR_LOG_CAP) errors.push({ row_index: idx, error: (e as Error).message.slice(0, 240) });
          else droppedErrors++;
        }
      }
      cursor += pendingRows.length;
      pendingRows.length = 0;
      const payload: Record<string, unknown> = { errors };
      if (droppedErrors > 0) payload.dropped = droppedErrors;
      if (skippedRows > 0) payload.skipped_rows = skippedRows;
      await env.DB.prepare(
        `UPDATE csv_imports
           SET processed_rows = ?,
               created_entities = created_entities + ?,
               updated_entities = updated_entities + ?,
               error_log_json = ?,
               updated_at = ?
         WHERE id = ?`,
      ).bind(cursor, created, updated, JSON.stringify(payload), new Date().toISOString(), importId).run();
      created = 0; updated = 0;
    };

    // Task #5: process one data record — used both by the buffered
    // header-decision replay path AND by the streaming loop once headers
    // have been resolved.
    const processDataRecord = async (record: string[]): Promise<boolean> => {
      if (totalSeen < startCursor) { totalSeen++; return true; }
      if (cursor + pendingRows.length >= inlineEnd) { hitCap = true; return false; }
      pendingRows.push(record);
      totalSeen++;
      if (!detected && pendingRows.length >= Math.min(5, INLINE_ROW_CAP)) {
        detected = await detectSchema(env, headers!, pendingRows.slice(0, 5));
        if (!detected) { needsManualMapping = true; return false; }
        await env.DB.prepare(
          "UPDATE csv_imports SET detected_columns_json = ?, updated_at = ? WHERE id = ?",
        ).bind(JSON.stringify(detected), new Date().toISOString(), importId).run();
        // Task #5: if the mapping came from the deterministic
        // fallback (longest avg non-URL column), the caller surfaces
        // the proposed mapping but holds the import for operator
        // review — no rows are written until the operator confirms.
        if (isFallbackMapping(detected)) { needsManualMapping = true; return false; }
      }
      if (pendingRows.length >= BATCH_SIZE && detected) await flushBatch();
      return true;
    };

    // Task #5: decide row 0 = headers vs no-header by sampling the
    // buffered records, then replay every non-header buffered row
    // through processDataRecord so the rest of the loop is unchanged.
    const finalizeHeaders = async (): Promise<boolean> => {
      if (headers) return true;
      if (!headerBuffer.length) return true;
      const hasHeader = detectHasHeader(headerBuffer);
      let dataRows: string[][];
      if (hasHeader) {
        headers = headerBuffer[0].map((h) => h.trim());
        dataRows = headerBuffer.slice(1);
      } else {
        const cols = headerBuffer.reduce((m, r) => Math.max(m, r.length), 0);
        headers = synthesizeHeaders(cols);
        dataRows = headerBuffer.slice();
      }
      headerBuffer.length = 0;
      for (const r of dataRows) {
        if (!(await processDataRecord(r))) return false;
      }
      return true;
    };

    const handleRecord = async (record: string[]): Promise<boolean> => {
      // Returns true to keep reading, false when the inline cap is hit.
      if (!headers) {
        headerBuffer.push(record);
        if (headerBuffer.length < HEADER_SAMPLE) return true;
        return finalizeHeaders();
      }
      return await processDataRecord(record);
    };

    let keepReading = true;
    while (keepReading) {
      const { done, value } = await reader.read();
      const chunk = done ? "" : decoder.decode(value, { stream: true });
      leftover += chunk;
      // Split leftover into complete records, leaving an unterminated
      // tail in `leftover`. Track quote state across chunk boundaries.
      let lastBoundary = 0;
      for (let i = 0; i < leftover.length; i++) {
        const ch = leftover[i];
        if (ch === '"') {
          if (inQuotes && leftover[i + 1] === '"') { i++; continue; }
          inQuotes = !inQuotes;
        } else if (ch === "\n" && !inQuotes) {
          let line = leftover.slice(lastBoundary, i);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          lastBoundary = i + 1;
          if (line.length === 0 && !headers) continue; // skip leading blanks
          const record = parseCsvLine(line);
          if (!await handleRecord(record)) { keepReading = false; break; }
        }
      }
      leftover = leftover.slice(lastBoundary);
      if (done) {
        // Flush any trailing record without a terminating newline.
        if (leftover.length && !inQuotes) {
          const record = parseCsvLine(leftover);
          await handleRecord(record);
          leftover = "";
        }
        // Task #5: file ended before the header-sample buffer filled
        // up. Resolve headers now using whatever rows we have so
        // short files still flow through processDataRecord.
        if (!headers && headerBuffer.length) await finalizeHeaders();
        reachedEof = true;
        break;
      }
    }
    // EOF-trigger detect for short files (<5 data rows): handleRecord
    // only triggers detection when pendingRows hits the 5-sample
    // threshold. Without this, files with 1–4 rows would never call
    // detectSchema and would silently complete with zero entities.
    if (!detected && headers && pendingRows.length > 0 && !needsManualMapping) {
      detected = await detectSchema(env, headers, pendingRows.slice(0, 5));
      if (!detected) needsManualMapping = true;
      else {
        await env.DB.prepare(
          "UPDATE csv_imports SET detected_columns_json = ?, updated_at = ? WHERE id = ?",
        ).bind(JSON.stringify(detected), new Date().toISOString(), importId).run();
        if (isFallbackMapping(detected)) needsManualMapping = true;
      }
    }
    try { await reader.cancel(); } catch { /* swallow */ }

    if (needsManualMapping) {
      await env.DB.prepare(
        "UPDATE csv_imports SET status = 'needs_manual_mapping', detected_columns_json = '{}', updated_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), importId).run();
      return;
    }
    if (detected && pendingRows.length) await flushBatch();

    const isComplete = reachedEof && !hitCap;
    // total_rows is the count we've actually seen so far (file fully
    // consumed when isComplete, or the partial checkpoint when chained).
    await env.DB.prepare("UPDATE csv_imports SET total_rows = ?, updated_at = ? WHERE id = ?")
      .bind(Math.max(totalSeen, cursor), new Date().toISOString(), importId).run();

    if (isComplete) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE csv_imports SET status = 'completed', completed_at = ?, last_imported_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, now, importId).run();
    } else {
      // >5,000 rows: hand off to CsvImportWorkflow (durable
      // checkpoint+resume on processed_rows). CRITICAL: only spawn the
      // workflow on the INITIAL invocation (insideWorkflow=false). When
      // CsvImportWorkflow.run calls processCsvImport for each chunk it
      // passes insideWorkflow=true, so chunk completions just return
      // and let the workflow's own loop drive the next step.do —
      // otherwise every chunk would spawn a fresh duplicate workflow.
      if (opts.insideWorkflow) {
        // no-op: the calling workflow's step loop will invoke
        // processCsvImport again for the next chunk.
      } else if (env.WF_CSV_IMPORT?.create) {
        try {
          await env.WF_CSV_IMPORT.create({ params: { importId } });
        } catch (e) {
          console.warn("csv_import workflow create failed; falling back to queue", (e as Error).message);
          await requeueResume(env, importId);
        }
      } else {
        await requeueResume(env, importId);
      }
    }
  } catch (e) {
    await env.DB.prepare(
      "UPDATE csv_imports SET status = 'failed', error_log_json = ?, updated_at = ? WHERE id = ?",
    ).bind(
      JSON.stringify({ errors: [{ row_index: -1, error: (e as Error).message.slice(0, 500) }] }),
      new Date().toISOString(),
      importId,
    ).run();
    throw e;
  }
}

async function requeueResume(env: Env, importId: string): Promise<void> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'csv_import', ?, ?, ?, ?)`,
  ).bind(jobId, `csv_import:resume:${importId}`, "csv_import", importId, JSON.stringify({ importId, resume: true }), now, now).run();
  await env.LEAD_QUEUE.send({ jobId, kind: "csv_import" as never, target: importId, config: { importId, resume: true } });
}

async function setStatus(env: Env, importId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE csv_imports SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, new Date().toISOString(), importId).run();
}

// ---- CSV parser (RFC 4180-ish; quoted fields, doubled-quote escapes) -----
// Inline parser instead of papaparse: bundle size + Workers compat + the
// shapes we accept (text/csv from operators) don't need streaming yet
// because INLINE_ROW_CAP already bounds memory. A 5,000-row chunk of
// typical 200-byte rows is ~1 MB.
// Parse a single CSV line (no embedded LFs — caller has already split on
// unquoted newlines via the streaming loop). Handles quoted fields and
// doubled-quote escapes.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(field); field = ""; }
      else field += ch;
    }
  }
  out.push(field);
  return out;
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cur.push(field); field = ""; }
      else if (ch === "\n") { cur.push(field); out.push(cur); cur = []; field = ""; }
      else if (ch === "\r") { /* swallow; \r\n handled by the \n branch */ }
      else field += ch;
    }
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  // Drop trailing empty record (file ends with a newline).
  while (out.length && out[out.length - 1].every((c) => c === "")) out.pop();
  const headers = out.shift() ?? [];
  return { headers: headers.map((h) => h.trim()), rows: out };
}

// ---- Schema auto-detection ------------------------------------------------
const DETECT_SCHEMA = {
  type: "object",
  properties: {
    entity_type: { type: "string", enum: ["person", "company", "fund"] },
    column_map: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          predicate: { type: ["string", "null"] },
          value_type: { type: "string" },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
        required: ["predicate", "value_type", "confidence"],
      },
    },
  },
  required: ["entity_type", "column_map"],
} as const;

const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

async function detectSchema(env: Env, headers: string[], sample: string[][]): Promise<DetectedColumns | null> {
  // Per spec: AI is the source of truth. The heuristic mapper is only
  // used when no AI binding is configured (dev/test environments) —
  // never as a silent fallback after model failure. If both AI attempts
  // fail in a real environment, the handler must mark the import
  // status='needs_manual_mapping' with detected_columns_json='{}'.
  if (!env.AI) {
    // Dev/test path: heuristic mapper + strict validation. If invalid,
    // try the deterministic fallback (longest avg non-URL column);
    // if even that yields nothing, return null so caller marks
    // status='needs_manual_mapping'.
    const h = heuristicDetect(headers);
    if (isNameMappingValid(h, headers, sample)) return h;
    return repairNameMapping(h, headers, sample);
  }
  const prompt = buildDetectPrompt(headers, sample);
  let lastParsed: DetectedColumns | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const model = attempt === 0 ? PRIMARY_MODEL : FALLBACK_MODEL;
      const res = (await env.AI.run(model, {
        messages: [
          { role: "system", content: "You map spreadsheet headers to entity predicates. Reply with strict JSON matching the schema. Never invent predicates — use null for unknown headers and put a brief reason in notes. The `firm.name` column MUST hold proper-noun brand names, never Type/Kind labels like 'VC', 'Nonprofit', 'Angel', country codes, or short uppercase categorical tokens." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_schema", json_schema: DETECT_SCHEMA },
      })) as { response?: string; entity_type?: string; column_map?: unknown };
      const parsed = parseDetectResponse(res);
      if (!parsed) continue;
      lastParsed = parsed;
      // Task #5: validate the proposed firm.name column against the
      // proper-noun + type-string gates. On attempt 0, fall through
      // to attempt 1 (different model) when invalid.
      if (isNameMappingValid(parsed, headers, sample)) return parsed;
    } catch (e) {
      console.warn("detectSchema attempt failed", attempt, (e as Error).message);
    }
  }
  // Both AI attempts failed validation. Deterministic fallback per
  // task spec: pick the longest avg non-URL/non-type column as
  // firm.name. The caller is still expected to surface this for
  // operator review (the returned column_map carries a `fallback:`
  // notes marker that the handler uses to set
  // status='needs_manual_mapping' so the operator confirms before
  // bulk inserts proceed) — i.e. NOT silently accepted as final.
  if (lastParsed) {
    const repaired = repairNameMapping(lastParsed, headers, sample);
    if (repaired) return repaired;
  }
  return null;
}

// True when the firm.name column was assigned by repairNameMapping
// (caller uses this to set status='needs_manual_mapping' even though
// detectSchema returned a usable mapping — the operator must confirm
// the heuristic pick before rows are written).
function isFallbackMapping(detected: DetectedColumns): boolean {
  for (const entry of Object.values(detected.column_map)) {
    if (entry?.predicate === "firm.name" && typeof entry.notes === "string"
        && entry.notes.startsWith("fallback:")) return true;
  }
  return false;
}

// Deterministic fallback per spec: pick the column whose sample cells
// have the highest average length AMONG columns that never contain a
// URL/money/ISO2/type-string/numeric cell. Returns a patched
// DetectedColumns or null if no column qualifies.
function repairNameMapping(
  detected: DetectedColumns,
  headers: string[],
  sample: string[][],
): DetectedColumns | null {
  let bestIdx = -1;
  let bestAvg = 0;
  for (let i = 0; i < headers.length; i++) {
    let total = 0, count = 0, disqualified = false;
    for (const row of sample) {
      const v = (row[i] ?? "").trim();
      if (!v) continue;
      if (!looksLikeProperNoun(v) || looksLikeTypeString(v)) { disqualified = true; break; }
      total += v.length;
      count++;
    }
    if (disqualified || count === 0) continue;
    const avg = total / count;
    if (avg > bestAvg) { bestAvg = avg; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  const patched: DetectedColumns = {
    entity_type: detected.entity_type,
    column_map: { ...detected.column_map },
  };
  for (const h of headers) {
    const m = patched.column_map[h];
    if (m?.predicate === "firm.name") {
      patched.column_map[h] = { ...m, predicate: null, notes: "rejected by name-mapping validator" };
    }
  }
  const chosen = headers[bestIdx];
  patched.column_map[chosen] = {
    predicate: "firm.name",
    value_type: "text",
    confidence: 0.5,
    notes: "fallback: longest avg non-URL non-type column (operator review required)",
  };
  return patched;
}

// ---- Task #5: firm.name mapping validation -------------------------------
// The proposed firm.name column is valid iff every non-empty sample
// value clears BOTH gates:
//
//   1. Type-string gate — NOT in TYPE_STRING_REGEX (single source of
//      truth in src/services/csv/headerDetector.ts).
//   2. Proper-noun-like gate — at least one alphabetic character,
//      length ≥ 2, NOT a short all-caps categorical token (≤4 chars
//      all uppercase, e.g. "USA", "VC", "EU"), NOT a pure number,
//      NOT a URL/email/money cell. Headers/cells with embedded
//      mixed-case letters (e.g. "Acme Ventures", "500 Startups")
//      always pass; bare categorical tokens never do.
//
// At least one sample row must be non-empty — empty-column mappings
// are rejected.
//
// On invalid mapping the caller does NOT silently substitute another
// column. Per spec contract, after the 2nd AI attempt fails this gate
// the import is moved to status='needs_manual_mapping' so an operator
// re-uploads with a corrected header / column choice.
function isNameMappingValid(
  detected: DetectedColumns,
  headers: string[],
  sample: string[][],
): boolean {
  const idx = headers.findIndex((h) => detected.column_map[h]?.predicate === "firm.name");
  if (idx < 0) return false;
  let nonEmpty = 0;
  for (const row of sample) {
    const v = (row[idx] ?? "").trim();
    if (!v) continue;
    nonEmpty++;
    if (looksLikeTypeString(v)) return false;
    if (!looksLikeProperNoun(v)) return false;
  }
  return nonEmpty > 0;
}

// Proper-noun-like = plausibly a brand/entity name. Rejects short
// uppercase categoricals (USA, VC, EU), pure digits, URLs, emails,
// money strings, and single chars.
function looksLikeProperNoun(value: string): boolean {
  const v = value.trim();
  if (v.length < 2) return false;
  if (!/[A-Za-z]/.test(v)) return false;             // must contain a letter
  if (/^https?:\/\//i.test(v)) return false;
  if (/\.(com|org|io|co|net|ai|app|dev|gov|edu)\b/i.test(v)) return false;
  if (/@/.test(v)) return false;
  if (/[$€£¥]/.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  if (/^\$?\d/.test(v)) return false;
  if (/\b\d+(?:[.,]\d+)?\s*[kmbKMB]\b/.test(v)) return false;
  // Short all-uppercase token with no spaces → categorical (USA, VC,
  // ANGEL). Allow "IBM" / "AMD" style brands by requiring >4 chars
  // for the all-caps reject.
  if (v.length <= 4 && /^[A-Z]+$/.test(v)) return false;
  return true;
}

function buildDetectPrompt(headers: string[], sample: string[][]): string {
  const sampleStr = sample.map((r) => headers.map((h, i) => `${h}=${r[i] ?? ""}`).join(" | ")).join("\n");
  return `Headers: ${headers.join(", ")}\n\nFirst rows:\n${sampleStr}\n\nMap each header to a predicate (e.g. firm.name, firm.website, firm.crunchbase_url, firm.linkedin_url, firm.hq_country_iso2, firm.thesis, firm.stages, firm.sectors, firm.aum_usd). Use null for unknown columns.`;
}

// Task #3 reviewer R5: strict predicate allowlist. The detector mustn't
// persist fabricated predicate strings into detected_columns_json — any
// downstream upsertFirm only honours these exact predicates anyway, so
// unknown predicates are normalized to `null` with a notes message
// explaining the rejection. This is the registry-backed allowlist for
// CSV-import detection (firm-table-backed predicates the upsert path
// actually reads, mirroring src/entities/profile-predicates.ts's
// person.* allowlist for the rich-profile surface).
export const CSV_IMPORT_ALLOWED_PREDICATES: ReadonlySet<string> = new Set([
  "firm.name", "firm.legal_name", "firm.website",
  "firm.hq_country_iso2", "firm.hq_city", "firm.hq_region",
  "firm.crunchbase_url", "firm.linkedin_url", "firm.twitter_handle",
  "firm.thesis", "firm.stages", "firm.sectors",
  "firm.aum_usd", "firm.founded_year", "firm.team_size",
  "firm.contact_email",
]);

function parseDetectResponse(res: { response?: string; entity_type?: string; column_map?: unknown }): DetectedColumns | null {
  let obj: { entity_type?: string; column_map?: unknown } | null = null;
  if (res && typeof res === "object" && typeof res.entity_type === "string") obj = res;
  else if (typeof res?.response === "string") {
    try { obj = JSON.parse(res.response); } catch { return null; }
  }
  if (!obj || typeof obj.entity_type !== "string") return null;
  const et = obj.entity_type;
  if (et !== "person" && et !== "company" && et !== "fund") return null;
  const cm = obj.column_map;
  if (!cm || typeof cm !== "object") return null;
  // Strict allowlist enforcement: any predicate the model returns that
  // isn't in CSV_IMPORT_ALLOWED_PREDICATES is normalized to predicate:null
  // with a notes field recording the rejected string. This prevents
  // fabricated mappings ever reaching the upsert path.
  const sanitized: DetectedColumns["column_map"] = {};
  for (const [header, entry] of Object.entries(cm as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      sanitized[header] = { predicate: null, value_type: "text", confidence: 0, notes: "invalid entry shape" };
      continue;
    }
    const e = entry as { predicate?: unknown; value_type?: unknown; confidence?: unknown; notes?: unknown };
    const pred = typeof e.predicate === "string" ? e.predicate.trim() : null;
    const vt = typeof e.value_type === "string" ? e.value_type : "text";
    const conf = typeof e.confidence === "number" ? e.confidence : 0;
    const notes = typeof e.notes === "string" ? e.notes : undefined;
    if (pred && CSV_IMPORT_ALLOWED_PREDICATES.has(pred)) {
      sanitized[header] = { predicate: pred, value_type: vt, confidence: conf, ...(notes ? { notes } : {}) };
    } else {
      sanitized[header] = {
        predicate: null,
        value_type: vt,
        confidence: 0,
        notes: pred ? `unknown predicate '${pred}' rejected by allowlist` : (notes ?? "no predicate"),
      };
    }
  }
  return { entity_type: et, column_map: sanitized };
}

// Heuristic header → predicate map. Recognizes the common columns from
// operator-curated VC/PE/investor lists (name, website, country,
// crunchbase, linkedin, twitter, etc.).
function heuristicDetect(headers: string[]): DetectedColumns {
  const column_map: DetectedColumns["column_map"] = {};
  for (const h of headers) {
    const k = h.toLowerCase().trim();
    let pred: string | null = null;
    let vt = "text";
    if (/^(name|firm|firm name|fund|fund name|investor|investor name|company|company name)$/.test(k)) pred = "firm.name";
    else if (/^(website|url|web|homepage|site)$/.test(k)) { pred = "firm.website"; vt = "url"; }
    else if (/^(legal name|legal)$/.test(k)) pred = "firm.legal_name";
    else if (/^(country|hq country|location country)$/.test(k)) { pred = "firm.hq_country_iso2"; vt = "iso2"; }
    else if (/^(city|hq city)$/.test(k)) pred = "firm.hq_city";
    else if (/^(region|hq region|state)$/.test(k)) pred = "firm.hq_region";
    else if (/crunchbase/.test(k)) { pred = "firm.crunchbase_url"; vt = "url"; }
    else if (/linkedin/.test(k)) { pred = "firm.linkedin_url"; vt = "url"; }
    else if (/twitter|^x\b/.test(k)) pred = "firm.twitter_handle";
    else if (/^(thesis|description|about|summary|focus)$/.test(k)) pred = "firm.thesis";
    else if (/^(stage|stages)$/.test(k)) { pred = "firm.stages"; vt = "list"; }
    else if (/^(sector|sectors|industry|industries)$/.test(k)) { pred = "firm.sectors"; vt = "list"; }
    else if (/^(aum|aum_usd|assets under management)$/.test(k)) { pred = "firm.aum_usd"; vt = "money"; }
    else if (/^(founded|year founded|founded year)$/.test(k)) { pred = "firm.founded_year"; vt = "int"; }
    else if (/^(team size|employees|headcount)$/.test(k)) { pred = "firm.team_size"; vt = "int"; }
    else if (/^(email|contact email)$/.test(k)) { pred = "firm.contact_email"; vt = "email"; }
    column_map[h] = { predicate: pred, value_type: vt, confidence: pred ? 0.8 : 0.0, ...(pred ? {} : { notes: "no heuristic match" }) };
  }
  return { entity_type: "company", column_map };
}

// ---- Row → FirmCandidate projection --------------------------------------
function rowToFirmCandidate(headers: string[], cells: string[], detected: DetectedColumns): FirmCandidate | null {
  const get = (pred: string): string => {
    for (let i = 0; i < headers.length; i++) {
      const m = detected.column_map[headers[i]];
      if (m?.predicate === pred) return (cells[i] ?? "").trim();
    }
    return "";
  };
  const name = get("firm.name");
  const website = get("firm.website") || null;
  const crunchbase_url = get("firm.crunchbase_url") || null;
  // Quality gate: upsertFirm requires name + (domain OR website). Skip
  // rows without enough to dedupe so the importer never creates orphans.
  if (!name || (!website && !crunchbase_url)) return null;
  const founded = parseInt(get("firm.founded_year"), 10);
  const team = parseInt(get("firm.team_size"), 10);
  const aum = parseMoney(get("firm.aum_usd"));
  const stages = splitList(get("firm.stages"));
  const sectors = splitList(get("firm.sectors"));
  return {
    name,
    website,
    crunchbase_url,
    legal_name: get("firm.legal_name") || null,
    hq_country_iso2: normalizeIso2(get("firm.hq_country_iso2")),
    hq_city: get("firm.hq_city") || null,
    hq_region: get("firm.hq_region") || null,
    linkedin_url: get("firm.linkedin_url") || null,
    twitter_handle: get("firm.twitter_handle") || null,
    thesis: get("firm.thesis") || null,
    contact_email: get("firm.contact_email") || null,
    stages,
    sectors,
    aum_usd: Number.isFinite(aum) ? aum : null,
    founded_year: Number.isFinite(founded) ? founded : null,
    team_size: Number.isFinite(team) ? team : null,
    source_url: null,
  };
}

// Pre-upsert dedupe per Task #3 contract: natural key is
// lower(trim(name)) + canonical(website) + canonical(crunchbase_url).
// upsertFirm already dedupes on (lower(name), domain); we extend the
// match to canonicalized website/crunchbase_url so a row with a
// matching crunchbase URL but a stale/missing website still merges.
// On hit, we re-bind candidate.domain to the matched row so upsertFirm
// finds the existing firm and merges instead of inserting.
async function applyNaturalKeyDedupe(env: Env, c: FirmCandidate): Promise<void> {
  const lname = c.name.trim().toLowerCase();
  const website = canonicalUrl(c.website);
  const cbUrl = canonicalUrl(c.crunchbase_url);
  const domain = c.domain?.toLowerCase().trim() || (website ? extractDomain(website) : null);
  if (cbUrl) {
    const hit = await env.DB.prepare(
      "SELECT id, domain, website FROM firms WHERE lower(name) = ? AND lower(crunchbase_url) = ? LIMIT 1",
    ).bind(lname, cbUrl).first<{ id: number; domain: string | null; website: string | null }>();
    if (hit) {
      c.domain = hit.domain || (hit.website ? extractDomain(hit.website) || null : null) || domain;
      return;
    }
  }
  if (website) {
    const hit = await env.DB.prepare(
      "SELECT id, domain, website FROM firms WHERE lower(name) = ? AND (lower(website) = ? OR lower(domain) = ?) LIMIT 1",
    ).bind(lname, website, domain ?? "").first<{ id: number; domain: string | null; website: string | null }>();
    if (hit) {
      c.domain = hit.domain || (hit.website ? extractDomain(hit.website) || null : null) || domain;
      return;
    }
  }
  if (domain) c.domain = domain;
}

function canonicalUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const t = u.trim().toLowerCase();
  if (!t) return null;
  return t.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function splitList(s: string): string[] | null {
  if (!s) return null;
  const parts = s.split(/[;,\|\/]/).map((p) => p.trim()).filter((p) => p.length);
  return parts.length ? parts : null;
}
function normalizeIso2(s: string): string | null {
  const v = s.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}
function parseMoney(s: string): number {
  if (!s) return NaN;
  const m = /([\d,\.]+)\s*([kKmMbB])?/.exec(s.trim());
  if (!m) return NaN;
  let n = parseFloat(m[1].replace(/,/g, ""));
  const mult = m[2]?.toLowerCase();
  if (mult === "k") n *= 1_000;
  else if (mult === "m") n *= 1_000_000;
  else if (mult === "b") n *= 1_000_000_000;
  return n;
}
function safeJson<T>(s: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
