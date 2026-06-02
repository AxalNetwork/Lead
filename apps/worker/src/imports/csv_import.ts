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
import { createEntity } from "../entities/roles";
import { insertFactsBatch, type FactPatch } from "../entities/facts";
import { upsertChannel } from "../entities/channels";
import { canonicalEmail, canonicalLinkedin, canonicalTwitter, canonicalPhone } from "../entities/normalize";

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
  filename: string | null;
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
    .prepare("SELECT id, user_email, r2_key, filename, status, processed_rows, detected_columns_json, error_log_json FROM csv_imports WHERE id = ?")
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
    // Person facts carry the operator-facing filename in their `source`
    // per the Task #12 contract (csv_import:<filename>). Falls back to the
    // import id when the row has no stored filename.
    const personSource = `csv_import:${row.filename ?? importId}`;

    const flushBatch = async (): Promise<void> => {
      if (!pendingRows.length || !detected) { pendingRows.length = 0; return; }
      for (const cells of pendingRows) {
        const idx = totalSeen - pendingRows.length + pendingRows.indexOf(cells); // best-effort index
        try {
          // Task #12: person CSVs flow through a first-class person upsert
          // path (dedupe into existing profiles, all facts via insertFact).
          // Firm behavior below is untouched.
          if (detected.entity_type === "person") {
            const pc = rowToPersonCandidate(headers!, cells, detected);
            if (!pc) continue; // skipped (no usable name/email/linkedin)
            const res = await upsertPerson(env, pc, personSource);
            if (res.action === "created") created++;
            else if (res.action === "updated") updated++;
            else {
              // createEntity's garbage/reclassify guard rejected the row.
              skippedRows++;
              if (errors.length < ERROR_LOG_CAP) errors.push({ row_index: idx, error: `person_rejected:${(pc.display_name ?? "").slice(0, 80)}` });
              else droppedErrors++;
            }
            continue;
          }
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
      // Preserve the proposed (fallback or partial) mapping in
      // detected_columns_json so the operator sees what the system
      // inferred and can confirm/edit it. Empty object only when
      // detection truly produced nothing.
      const proposedJson = detected ? JSON.stringify(detected) : "{}";
      await env.DB.prepare(
        "UPDATE csv_imports SET status = 'needs_manual_mapping', detected_columns_json = ?, updated_at = ? WHERE id = ?",
      ).bind(proposedJson, new Date().toISOString(), importId).run();
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
    if (h.entity_type === "person") return isPersonMappingValid(h) ? h : null;
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
      // Task #12: a person mapping is accepted as soon as it carries a
      // usable identity column (name OR email OR linkedin) — the firm.name
      // proper-noun gates below don't apply to people.
      if (parsed.entity_type === "person") {
        if (isPersonMappingValid(parsed)) return parsed;
        continue;
      }
      // Task #5: validate the proposed firm.name column against the
      // proper-noun + type-string gates. On attempt 0, fall through
      // to attempt 1 (different model) when invalid.
      if (isNameMappingValid(parsed, headers, sample)) return parsed;
    } catch (e) {
      console.warn("detectSchema attempt failed", attempt, (e as Error).message);
    }
  }
  // Both AI attempts failed validation (or failed to parse). Run the
  // deterministic fallback per task spec: pick the longest avg
  // non-URL/non-type column as firm.name. When AI returned nothing
  // parseable at all, seed the repair with the heuristicDetect
  // mapping so other predicates (website, country, etc.) still get
  // their best-effort assignment. Caller marks
  // status='needs_manual_mapping' on any column carrying the
  // `fallback:` notes marker — not silently accepted as final.
  // Task #12: if the headers look like people, fall back to the heuristic
  // person detector (never the firm name-repair path). When the AI itself
  // said "person" but produced no usable identity column, stay honest and
  // return null → needs_manual_mapping rather than guessing a firm name.
  const heur = heuristicDetect(headers);
  if (heur.entity_type === "person") {
    if (isPersonMappingValid(heur)) return heur;
    return null;
  }
  if (lastParsed?.entity_type === "person") return null;
  const seed = lastParsed ?? heur;
  const repaired = repairNameMapping(seed, headers, sample);
  if (repaired) return repaired;
  return null;
}

// Task #12: a person mapping is usable iff it carries at least one
// identity column — a name part (full/first/last) OR a contact key
// (email/linkedin). Mirrors the firm.name validity gate for people but
// without the proper-noun heuristics (personal names are far more varied).
function isPersonMappingValid(detected: DetectedColumns): boolean {
  let hasName = false, hasContact = false;
  for (const e of Object.values(detected.column_map)) {
    const p = e?.predicate;
    if (p === "person.full_name" || p === "person.first_name" || p === "person.last_name") hasName = true;
    else if (p === "person.email" || p === "person.linkedin_url") hasContact = true;
  }
  return hasName || hasContact;
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
  return `Headers: ${headers.join(", ")}\n\nFirst rows:\n${sampleStr}\n\nDecide whether the rows describe organizations (firms/funds/companies) or individual people, and set entity_type accordingly.\nFor organizations use firm.* predicates: firm.name, firm.website, firm.crunchbase_url, firm.linkedin_url, firm.hq_country_iso2, firm.hq_city, firm.hq_region, firm.thesis, firm.stages, firm.sectors, firm.aum_usd, firm.founded_year, firm.team_size, firm.contact_email.\nFor individual people (first/last names, job titles, personal emails, LinkedIn profiles, event attendees, network connections) use person.* predicates: person.full_name, person.first_name, person.last_name, person.email, person.linkedin_url, person.twitter_handle, person.title, person.company, person.city, person.country, person.location, person.connected_on, person.phone, person.notes.\nUse null for unknown columns.`;
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
  // Task #12: person/contact predicates for LinkedIn Connections,
  // event attendee lists, and similar individual-person CSVs.
  "person.full_name", "person.first_name", "person.last_name",
  "person.email", "person.linkedin_url", "person.twitter_handle",
  "person.title", "person.company", "person.phone",
  "person.city", "person.country", "person.location",
  "person.connected_on", "person.notes",
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
export function heuristicDetect(headers: string[]): DetectedColumns {
  const personMap: DetectedColumns["column_map"] = {};
  const firmMap: DetectedColumns["column_map"] = {};
  // Task #12: score person-vs-firm from headers alone. Strong person
  // signals (first/last name, "connected on") force a person verdict;
  // otherwise person wins only when it out-scores firm AND clears a
  // minimum bar, so ambiguous low-signal firm lists keep firm behavior.
  let personScore = 0, firmScore = 0;
  let hasFirst = false, hasLast = false, hasConnected = false;
  const setMap = (
    map: DetectedColumns["column_map"], h: string, pred: string | null, vt: string,
  ) => { map[h] = pred ? { predicate: pred, value_type: vt, confidence: 0.8 } : { predicate: null, value_type: "text", confidence: 0, notes: "no heuristic match" }; };
  for (const h of headers) {
    const k = h.toLowerCase().trim();
    // ---- person predicate guess --------------------------------------
    let pp: string | null = null, pvt = "text";
    if (/^(first name|first_name|given name|firstname|first)$/.test(k)) { pp = "person.first_name"; hasFirst = true; personScore += 1; }
    else if (/^(last name|last_name|surname|family name|lastname|last)$/.test(k)) { pp = "person.last_name"; hasLast = true; personScore += 1; }
    else if (/^(full name|name|contact name|attendee|attendee name|full_name|display name)$/.test(k)) { pp = "person.full_name"; personScore += 0.5; }
    else if (/^(email|e-mail|email address|work email|personal email|contact email)$/.test(k)) { pp = "person.email"; pvt = "email"; personScore += 0.5; }
    else if (/linkedin/.test(k)) { pp = "person.linkedin_url"; pvt = "url"; personScore += 0.5; }
    else if (/^(url|profile|profile url)$/.test(k)) { pp = "person.linkedin_url"; pvt = "url"; }
    else if (/twitter|^x$|x handle|x \(twitter\)/.test(k)) { pp = "person.twitter_handle"; }
    else if (/^(position|title|job title|jobtitle|role|headline|designation|current position)$/.test(k)) { pp = "person.title"; personScore += 1; }
    else if (/^(company|organization|organisation|employer|current company|company name)$/.test(k)) { pp = "person.company"; personScore += 0.5; }
    else if (/^(city|town)$/.test(k)) { pp = "person.city"; }
    else if (/^(country|nation)$/.test(k)) { pp = "person.country"; }
    else if (/^(location|region|state|province|geo|area)$/.test(k)) { pp = "person.location"; }
    else if (/^(connected on|connected_on|connection date|date connected|connected)$/.test(k)) { pp = "person.connected_on"; hasConnected = true; personScore += 2; }
    else if (/^(phone|mobile|tel|telephone|cell|phone number)$/.test(k)) { pp = "person.phone"; }
    else if (/^(notes?|comments?|remark)$/.test(k)) { pp = "person.notes"; }
    setMap(personMap, h, pp, pvt);
    // ---- firm predicate guess (unchanged behavior) -------------------
    let fp: string | null = null, fvt = "text";
    if (/^(name|firm|firm name|fund|fund name|investor|investor name|company|company name)$/.test(k)) { fp = "firm.name"; if (/firm|fund|investor/.test(k)) firmScore += 1; }
    else if (/^(website|url|web|homepage|site)$/.test(k)) { fp = "firm.website"; fvt = "url"; firmScore += 1; }
    else if (/^(legal name|legal)$/.test(k)) fp = "firm.legal_name";
    else if (/^(country|hq country|location country)$/.test(k)) { fp = "firm.hq_country_iso2"; fvt = "iso2"; }
    else if (/^(city|hq city)$/.test(k)) fp = "firm.hq_city";
    else if (/^(region|hq region|state)$/.test(k)) fp = "firm.hq_region";
    else if (/crunchbase/.test(k)) { fp = "firm.crunchbase_url"; fvt = "url"; firmScore += 1; }
    else if (/linkedin/.test(k)) { fp = "firm.linkedin_url"; fvt = "url"; }
    else if (/twitter|^x\b/.test(k)) fp = "firm.twitter_handle";
    else if (/^(thesis|description|about|summary|focus)$/.test(k)) { fp = "firm.thesis"; firmScore += 1; }
    else if (/^(stage|stages)$/.test(k)) { fp = "firm.stages"; fvt = "list"; firmScore += 1; }
    else if (/^(sector|sectors|industry|industries)$/.test(k)) { fp = "firm.sectors"; fvt = "list"; firmScore += 1; }
    else if (/^(aum|aum_usd|assets under management)$/.test(k)) { fp = "firm.aum_usd"; fvt = "money"; firmScore += 2; }
    else if (/^(founded|year founded|founded year)$/.test(k)) { fp = "firm.founded_year"; fvt = "int"; firmScore += 1; }
    else if (/^(team size|employees|headcount)$/.test(k)) { fp = "firm.team_size"; fvt = "int"; firmScore += 1; }
    else if (/^(email|contact email)$/.test(k)) { fp = "firm.contact_email"; fvt = "email"; }
    setMap(firmMap, h, fp, fvt);
  }
  const strongPerson = hasFirst || hasLast || hasConnected;
  const isPerson = strongPerson || (personScore > firmScore && personScore >= 1.5);
  return isPerson
    ? { entity_type: "person", column_map: personMap }
    : { entity_type: "company", column_map: firmMap };
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

// ---- Row → person candidate projection -----------------------------------
// Task #12: projects one CSV row into a normalized person candidate.
// Mapped person.* columns are pulled by predicate; every unmapped,
// non-empty column is retained verbatim in `raw` so no operator data is
// silently dropped.
export interface PersonCandidate {
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;        // canonical
  linkedin_url: string | null; // canonical
  twitter_handle: string | null;
  title: string | null;
  company: string | null;
  phone: string | null;        // canonical
  city: string | null;
  country: string | null;
  location: string | null;
  connected_on: string | null;
  notes: string | null;
  raw: Record<string, string>; // unmapped columns: slug -> value
}

export function rowToPersonCandidate(headers: string[], cells: string[], detected: DetectedColumns): PersonCandidate | null {
  const get = (pred: string): string => {
    for (let i = 0; i < headers.length; i++) {
      const m = detected.column_map[headers[i]];
      if (m?.predicate === pred) return (cells[i] ?? "").trim();
    }
    return "";
  };
  const first = get("person.first_name") || null;
  const last = get("person.last_name") || null;
  const full = get("person.full_name") || null;
  const display = full || ([first, last].filter(Boolean).join(" ").trim() || null);
  const email = canonicalEmail(get("person.email"));
  const linkedin = canonicalLinkedin(get("person.linkedin_url"));
  // Quality gate: a row is only a usable person when it carries at least
  // one durable identifier — a name (>=2 chars) OR a canonical email OR a
  // canonical LinkedIn. Empty / junk rows are skipped (never created).
  const hasName = !!(display && display.trim().length >= 2);
  if (!hasName && !email && !linkedin) return null;
  const raw: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const m = detected.column_map[headers[i]];
    if (m?.predicate) continue;
    const v = (cells[i] ?? "").trim();
    if (!v) continue;
    const slug = slugifyHeader(headers[i]) || `col_${i}`;
    if (!(slug in raw)) raw[slug] = v;
  }
  return {
    display_name: display,
    first_name: first,
    last_name: last,
    email,
    linkedin_url: linkedin,
    twitter_handle: canonicalTwitter(get("person.twitter_handle")),
    title: get("person.title") || null,
    company: get("person.company") || null,
    phone: canonicalPhone(get("person.phone")),
    city: get("person.city") || null,
    country: get("person.country") || null,
    location: get("person.location") || null,
    connected_on: get("person.connected_on") || null,
    notes: get("person.notes") || null,
    raw,
  };
}

function slugifyHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

// ---- Person upsert + dedupe ----------------------------------------------
// Resolution order (highest-confidence first): primary_email_key →
// email channel → primary_linkedin_key → linkedin channel → name+company
// fact join. On a hit we enrich in place (and backfill missing primary_*
// keys so the next import dedupes on the fast path); otherwise we mint a
// new person via createEntity (which applies the garbage/reclassify guard).
// All facts flow through insertFactsBatch with source_kind="import".
interface UpsertPersonResult { action: "created" | "updated" | "skipped"; entity_id?: string }

// Person-scoped channel lookup. Unlike the shared findEntityByChannel,
// this constrains the hit to kind='person' so a person import can never
// attach onto (and corrupt) an org/fund entity that happens to share the
// same email/LinkedIn channel. `canonical` is already canonicalized by the
// caller (channels store the canonical form).
async function findPersonByChannel(env: Env, kind: "email" | "linkedin", canonical: string): Promise<string | null> {
  if (!canonical) return null;
  const r = await env.DB.prepare(
    `SELECT c.entity_id FROM channels c
       JOIN u_entities e ON e.id = c.entity_id
      WHERE c.kind = ? AND c.canonical = ? AND e.kind = 'person'
        AND e.status NOT IN ('merged','soft_deleted')
      ORDER BY c.is_primary DESC, c.is_verified DESC, c.last_seen_at DESC LIMIT 1`,
  ).bind(kind, canonical).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

export async function upsertPerson(env: Env, c: PersonCandidate, source: string): Promise<UpsertPersonResult> {
  const emailKey = c.email;           // already canonical
  const linkedinKey = c.linkedin_url; // already canonical
  let entityId: string | null = null;

  if (emailKey) {
    const hit = await env.DB.prepare(
      "SELECT id FROM u_entities WHERE kind = 'person' AND primary_email_key = ? AND status NOT IN ('merged','soft_deleted') LIMIT 1",
    ).bind(emailKey).first<{ id: string }>();
    entityId = hit?.id ?? (await findPersonByChannel(env, "email", emailKey));
  }
  if (!entityId && linkedinKey) {
    const hit = await env.DB.prepare(
      "SELECT id FROM u_entities WHERE kind = 'person' AND primary_linkedin_key = ? AND status NOT IN ('merged','soft_deleted') LIMIT 1",
    ).bind(linkedinKey).first<{ id: string }>();
    entityId = hit?.id ?? (await findPersonByChannel(env, "linkedin", linkedinKey));
  }
  if (!entityId && c.display_name && c.company) {
    const hit = await env.DB.prepare(
      `SELECT e.id FROM u_entities e
         JOIN facts f ON f.entity_id = e.id AND f.predicate = 'primary_employer'
                     AND f.is_current = 1 AND lower(f.value_text) = ?
        WHERE e.kind = 'person' AND e.status NOT IN ('merged','soft_deleted')
          AND lower(e.display_name) = ? LIMIT 1`,
    ).bind(c.company.trim().toLowerCase(), c.display_name.trim().toLowerCase())
      .first<{ id: string }>();
    entityId = hit?.id ?? null;
  }

  let action: "created" | "updated";
  if (entityId) {
    action = "updated";
    await backfillPrimaryKeys(env, entityId, c);
  } else {
    const created = await createEntity(env, {
      kind: "person",
      display_name: c.display_name,
      primary_url: c.linkedin_url,
      primary_email_key: emailKey,
      primary_linkedin_key: linkedinKey,
      primary_twitter_handle: c.twitter_handle,
    });
    if (!created) return { action: "skipped" };
    entityId = created.id;
    action = "created";
  }

  // Canonical fact write path. Mirror the same person predicates the
  // lead→entity sync uses (name/title/primary_employer/city/region/
  // country_iso2), then retain every unmapped column as import.raw.<slug>.
  const patches: FactPatch[] = [];
  if (c.display_name) patches.push({ predicate: "name", value_text: c.display_name });
  if (c.title) patches.push({ predicate: "title", value_text: c.title });
  if (c.company) patches.push({ predicate: "primary_employer", value_text: c.company });
  if (c.city) patches.push({ predicate: "city", value_text: c.city });
  if (c.country) {
    const iso = normalizeIso2(c.country);
    if (iso) patches.push({ predicate: "country_iso2", value_text: iso });
  }
  if (c.location) patches.push({ predicate: "region", value_text: c.location });
  if (c.connected_on) patches.push({ predicate: "person.connected_on", value_text: c.connected_on });
  if (c.notes) patches.push({ predicate: "person.notes", value_text: c.notes });
  for (const [slug, val] of Object.entries(c.raw)) {
    patches.push({ predicate: `import.raw.${slug}`, value_text: val });
  }
  if (patches.length) await insertFactsBatch(env, entityId, patches, source, "import", null);

  if (emailKey) await upsertChannel(env, { entity_id: entityId, kind: "email", canonical: emailKey, source });
  if (linkedinKey) await upsertChannel(env, { entity_id: entityId, kind: "linkedin", canonical: linkedinKey, source });
  if (c.twitter_handle) await upsertChannel(env, { entity_id: entityId, kind: "twitter", canonical: c.twitter_handle, source });
  if (c.phone) await upsertChannel(env, { entity_id: entityId, kind: "phone", canonical: c.phone, source });

  return { action, entity_id: entityId };
}

async function backfillPrimaryKeys(env: Env, entityId: string, c: PersonCandidate): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (c.email) { sets.push("primary_email_key = COALESCE(primary_email_key, ?)"); binds.push(c.email); }
  if (c.linkedin_url) { sets.push("primary_linkedin_key = COALESCE(primary_linkedin_key, ?)"); binds.push(c.linkedin_url); }
  if (c.linkedin_url) { sets.push("primary_url = COALESCE(primary_url, ?)"); binds.push(c.linkedin_url); }
  if (c.twitter_handle) { sets.push("primary_twitter_handle = COALESCE(primary_twitter_handle, ?)"); binds.push(c.twitter_handle); }
  if (c.display_name) { sets.push("display_name = COALESCE(display_name, ?)"); binds.push(c.display_name); }
  if (!sets.length) return;
  binds.push(entityId);
  await env.DB.prepare(`UPDATE u_entities SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
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
