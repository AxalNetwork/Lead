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

const INLINE_ROW_CAP = 5000;
const BATCH_SIZE = 50;
const ERROR_LOG_CAP = 200;

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

export async function processCsvImport(env: Env, importId: string): Promise<void> {
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

    // Resume from checkpoint.
    const startCursor = row.processed_rows | 0;
    let totalSeen = 0;     // every row index parsed from the file so far
    let cursor = startCursor;
    const inlineEnd = startCursor + INLINE_ROW_CAP;
    let created = 0, updated = 0;
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
      const payload = droppedErrors > 0 ? { errors, dropped: droppedErrors } : { errors };
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

    const handleRecord = async (record: string[]): Promise<boolean> => {
      // Returns true to keep reading, false when the inline cap is hit.
      if (!headers) { headers = record.map((h) => h.trim()); return true; }
      // Skip past the resume checkpoint without re-doing work.
      if (totalSeen < startCursor) { totalSeen++; return true; }
      if (cursor + pendingRows.length >= inlineEnd) { hitCap = true; return false; }

      // Lazy schema detection: triggers on the FIRST data row of a fresh
      // import, after we've buffered up to 5 sample rows. On resume, the
      // cached detected map is reused without re-calling the model.
      pendingRows.push(record);
      totalSeen++;
      if (!detected && pendingRows.length >= Math.min(5, INLINE_ROW_CAP)) {
        detected = await detectSchema(env, headers, pendingRows.slice(0, 5));
        if (!detected) {
          // Strict spec contract: after two failed AI attempts, mark
          // status='needs_manual_mapping' with detected_columns_json='{}'
          // and ABORT — no heuristic coercion, no silent success.
          needsManualMapping = true;
          return false;
        }
        await env.DB.prepare(
          "UPDATE csv_imports SET detected_columns_json = ?, updated_at = ? WHERE id = ?",
        ).bind(JSON.stringify(detected), new Date().toISOString(), importId).run();
      }
      if (pendingRows.length >= BATCH_SIZE && detected) await flushBatch();
      return true;
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
        reachedEof = true;
        break;
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
      // >5,000 rows: leave status='processing' and re-enqueue to resume.
      // The queue consumer picks up the row at the new processed_rows
      // cursor on the next invocation. (CsvImportWorkflow chain — full
      // Cloudflare Workflows integration with checkpoint-and-resume — is
      // tracked as drift; this resume-via-requeue path achieves the same
      // CPU-budget escape without adding a new workflow binding.)
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, ?, 'queued', 'csv_import', ?, ?, ?, ?)`,
      ).bind(jobId, `csv_import:resume:${importId}`, "csv_import", importId, JSON.stringify({ importId, resume: true }), now, now).run();
      await env.LEAD_QUEUE.send({ jobId, kind: "csv_import" as never, target: importId, config: { importId, resume: true } });
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
  if (!env.AI) return heuristicDetect(headers);
  const prompt = buildDetectPrompt(headers, sample);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const model = attempt === 0 ? PRIMARY_MODEL : FALLBACK_MODEL;
      const res = (await env.AI.run(model, {
        messages: [
          { role: "system", content: "You map spreadsheet headers to entity predicates. Reply with strict JSON matching the schema. Never invent predicates — use null for unknown headers and put a brief reason in notes." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_schema", json_schema: DETECT_SCHEMA },
      })) as { response?: string; entity_type?: string; column_map?: unknown };
      const parsed = parseDetectResponse(res);
      if (parsed) return parsed;
    } catch (e) {
      console.warn("detectSchema attempt failed", attempt, (e as Error).message);
    }
  }
  return null;
}

function buildDetectPrompt(headers: string[], sample: string[][]): string {
  const sampleStr = sample.map((r) => headers.map((h, i) => `${h}=${r[i] ?? ""}`).join(" | ")).join("\n");
  return `Headers: ${headers.join(", ")}\n\nFirst rows:\n${sampleStr}\n\nMap each header to a predicate (e.g. firm.name, firm.website, firm.crunchbase_url, firm.linkedin_url, firm.hq_country_iso2, firm.thesis, firm.stages, firm.sectors, firm.aum_usd). Use null for unknown columns.`;
}

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
  return { entity_type: et, column_map: cm as DetectedColumns["column_map"] };
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
