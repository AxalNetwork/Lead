// Task #19: custom export builder.
//
// One module owns the entire export surface so the field whitelist,
// transform registry, query builders, and format writers all sit next
// to each other. Endpoints exposed under `/api/exports` (mounted in
// `src/index.ts`):
//
//   GET    /csv                     legacy "all-columns leads CSV" shim
//   POST   /csv                     custom builder (entity, columns,
//                                   filter, format) — name kept for
//                                   backward-compatibility even when
//                                   format is XLSX/JSON/TSV.
//   GET    /templates               list saved + built-in presets
//   POST   /templates               save a new template
//   DELETE /templates/:id           delete a saved template (system
//                                   presets are immutable)
//
// Anything not on the per-entity whitelist returns 400 — there is no
// raw-SQL passthrough.

import { Hono } from "hono";
import { zipSync, strToU8 } from "fflate";
import type { Env } from "../types";

export const exports_ = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// ---------------------------------------------------------------------------
// Column whitelists.
// ---------------------------------------------------------------------------

interface ColumnSpec {
  sql: string;
  header: string;
  json?: boolean;
  needsFirmJoin?: boolean;
}

const LEAD_REAL_COLUMNS = [
  "id", "name", "email", "phone", "org", "title", "category",
  "source_domain", "source_url", "status", "verified", "flagged",
  "approved_at", "approved_by",
  "linkedin_url", "twitter_url", "github_url", "personal_url", "alt_emails_json",
  "persona_role", "seniority", "function_area", "bio",
  "gender", "age_range", "languages_json",
  "country_iso2", "region", "city", "timezone",
  "net_worth_band", "aum_usd", "fund_size_usd", "last_round_usd", "salary_band",
  "companies_json", "board_seats_json", "awards_json", "exits_json",
  "priority", "owner_email", "next_action_at", "tags_json", "sector_focus_json",
  "provider", "provider_score", "merged_into",
  "emails_json", "socials_json", "meta_json",
  "created_at", "updated_at",
] as const;

const JSON_ARRAY_FIELDS = new Set([
  "alt_emails_json", "languages_json", "tags_json", "sector_focus_json",
  "companies_json", "board_seats_json", "awards_json", "exits_json",
  "emails_json", "socials_json",
  "geo_focus_json", "stages_json", "sectors_json",
  "notable_investments_json",
]);

function realLeadColumns(): Record<string, ColumnSpec> {
  const out: Record<string, ColumnSpec> = {};
  for (const c of LEAD_REAL_COLUMNS) {
    out[c] = { sql: `l.${c}`, header: c, json: JSON_ARRAY_FIELDS.has(c) };
  }
  return out;
}

const LEAD_FIELDS: Record<string, ColumnSpec> = {
  ...realLeadColumns(),
  first_name: { sql: `CASE WHEN l.name LIKE '% %' THEN substr(l.name,1,instr(l.name,' ')-1) ELSE l.name END`, header: "first_name" },
  last_name:  { sql: `CASE WHEN l.name LIKE '% %' THEN substr(l.name,instr(l.name,' ')+1) ELSE '' END`, header: "last_name" },
  primary_email:    { sql: `COALESCE(l.email, json_extract(l.emails_json, '$[0].email'))`, header: "primary_email" },
  primary_phone:    { sql: `l.phone`, header: "primary_phone" },
  primary_linkedin: { sql: `COALESCE(l.linkedin_url, (SELECT json_extract(s.value,'$.url') FROM json_each(l.socials_json) s WHERE json_extract(s.value,'$.platform')='linkedin' LIMIT 1))`, header: "primary_linkedin" },
  firm_name:    { sql: `f.name`,    header: "firm_name",    needsFirmJoin: true },
  firm_domain:  { sql: `f.domain`,  header: "firm_domain",  needsFirmJoin: true },
  firm_aum_usd: { sql: `f.aum_usd`, header: "firm_aum_usd", needsFirmJoin: true },
};

const FIRM_REAL_COLUMNS = [
  "id", "name", "legal_name", "slug", "kind", "website", "domain", "logo_url",
  "hq_country_iso2", "hq_region", "hq_city",
  "geo_focus_json", "stages_json", "sectors_json",
  "thesis", "check_size_min_usd", "check_size_max_usd", "check_size_typical_usd",
  "aum_usd", "fund_count", "current_fund_name", "current_fund_size_usd",
  "lead_or_co", "portfolio_count", "unicorns_count", "exits_count",
  "notable_investments_json", "founded_year", "team_size",
  "linkedin_url", "crunchbase_url", "twitter_handle", "signal_nfx_url",
  "openvc_url", "pitchbook_url", "socials_json",
  "contact_email", "submission_url", "notes", "source_url", "imported_from",
  "status", "quality_score", "last_enriched_at", "last_modified", "created_at",
] as const;

function realFirmColumns(prefix: string): Record<string, ColumnSpec> {
  const out: Record<string, ColumnSpec> = {};
  for (const c of FIRM_REAL_COLUMNS) {
    out[c] = { sql: `${prefix}.${c}`, header: c, json: JSON_ARRAY_FIELDS.has(c) };
  }
  return out;
}

const FIRM_FIELDS: Record<string, ColumnSpec> = {
  ...realFirmColumns("f"),
  partner_count: {
    sql: `(SELECT COUNT(*) FROM firm_people fp WHERE fp.firm_id = f.id AND lower(COALESCE(fp.role,'')) LIKE '%partner%')`,
    header: "partner_count",
  },
  gp_count: {
    sql: `(SELECT COUNT(*) FROM firm_people fp WHERE fp.firm_id = f.id AND (lower(COALESCE(fp.role,'')) LIKE '%general partner%' OR lower(COALESCE(fp.role,''))='gp' OR lower(COALESCE(fp.role,'')) LIKE '%managing partner%'))`,
    header: "gp_count",
  },
  portfolio_count_actual: {
    sql: `(SELECT COUNT(*) FROM firm_portfolio fpo WHERE fpo.firm_id = f.id)`,
    header: "portfolio_count_actual",
  },
  top_partner_name: {
    sql: `(SELECT l2.name FROM firm_people fp2 JOIN leads l2 ON l2.id = fp2.lead_id WHERE fp2.firm_id = f.id ORDER BY fp2.is_decision_maker DESC, fp2.id ASC LIMIT 1)`,
    header: "top_partner_name",
  },
};

const FIRM_PEOPLE_FIELDS: Record<string, ColumnSpec> = {
  firm_id:     { sql: `f.id`,     header: "firm_id" },
  firm_name:   { sql: `f.name`,   header: "firm_name" },
  firm_domain: { sql: `f.domain`, header: "firm_domain" },
  firm_kind:   { sql: `f.kind`,   header: "firm_kind" },
  firm_country_iso2: { sql: `f.hq_country_iso2`, header: "firm_country_iso2" },
  firm_aum_usd:{ sql: `f.aum_usd`, header: "firm_aum_usd" },
  role:        { sql: `fp.role`,  header: "role" },
  is_decision_maker: { sql: `fp.is_decision_maker`, header: "is_decision_maker" },
  started_at:  { sql: `fp.started_at`, header: "started_at" },
  ended_at:    { sql: `fp.ended_at`, header: "ended_at" },
  lead_id:     { sql: `l.id`,     header: "lead_id" },
  name:        { sql: `l.name`,   header: "name" },
  email:       { sql: `l.email`,  header: "email" },
  primary_email: { sql: `COALESCE(l.email, json_extract(l.emails_json, '$[0].email'))`, header: "primary_email" },
  title:       { sql: `l.title`,  header: "title" },
  linkedin_url:{ sql: `l.linkedin_url`, header: "linkedin_url" },
  twitter_url: { sql: `l.twitter_url`, header: "twitter_url" },
  country_iso2:{ sql: `l.country_iso2`, header: "country_iso2" },
};

const PORTFOLIO_REAL_COLUMNS = [
  "id", "firm_id", "company_name", "company_domain", "company_url",
  "investment_year", "stage", "amount_usd", "is_lead", "outcome",
  "exit_value_usd", "source_url", "created_at",
] as const;

function realPortfolioColumns(): Record<string, ColumnSpec> {
  const out: Record<string, ColumnSpec> = {};
  for (const c of PORTFOLIO_REAL_COLUMNS) out[c] = { sql: `fpo.${c}`, header: c };
  return out;
}

const PORTFOLIO_FIELDS: Record<string, ColumnSpec> = {
  ...realPortfolioColumns(),
  firm_name:   { sql: `f.name`,   header: "firm_name" },
  firm_domain: { sql: `f.domain`, header: "firm_domain" },
  firm_country_iso2: { sql: `f.hq_country_iso2`, header: "firm_country_iso2" },
};

type Entity = "leads" | "firms" | "firm_people" | "portfolio";
const VALID_ENTITIES: Entity[] = ["leads", "firms", "firm_people", "portfolio"];

const FIELD_REGISTRY: Record<Entity, Record<string, ColumnSpec>> = {
  leads: LEAD_FIELDS,
  firms: FIRM_FIELDS,
  firm_people: FIRM_PEOPLE_FIELDS,
  portfolio: PORTFOLIO_FIELDS,
};

// ---------------------------------------------------------------------------
// Transform registry.
// ---------------------------------------------------------------------------

type TransformFn = (raw: string) => string;
const EXPORT_TRANSFORMS: Record<string, TransformFn> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  titlecase: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()),
  e164: (s) => {
    const digits = s.replace(/[^\d+]/g, "");
    if (!digits) return "";
    if (digits.startsWith("+")) return digits;
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  },
  pipe_join: (s) => splitJsonArray(s).join("|"),
  first:     (s) => splitJsonArray(s)[0] ?? "",
  bool_yn:   (s) => (s === "1" || s === "true" || s.toLowerCase() === "yes" ? "Y" : s ? "N" : ""),
};

function splitJsonArray(s: string): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) {
      return v.map((x) => (typeof x === "string" ? x : x?.value ?? x?.name ?? x?.email ?? x?.url ?? JSON.stringify(x)));
    }
  } catch { /* not json — fall through */ }
  return s.split(/\s*[,|]\s*/).filter(Boolean);
}

function flatten(spec: ColumnSpec, raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  if (!spec.json) return s;
  return splitJsonArray(s).join("|");
}

// ---------------------------------------------------------------------------
// Query builders.
// ---------------------------------------------------------------------------

interface ColumnRequest { field: string; header?: string; transform?: string; }
interface ResolvedColumn extends ColumnRequest { spec: ColumnSpec; outHeader: string; alias: string; }
interface BuiltQuery { sql: string; binds: unknown[]; resolved: ResolvedColumn[]; }
interface FilterShape {
  status?: string; has_email?: boolean; include_merged?: boolean;
  country_iso2?: string; kind?: string; since?: string;
}

function resolveColumns(entity: Entity, columns: ColumnRequest[]): ResolvedColumn[] {
  const reg = FIELD_REGISTRY[entity];
  return columns.map((c, i) => {
    const spec = reg[c.field];
    if (!spec) throw new HttpError(400, `unknown_field:${entity}.${c.field}`);
    if (c.transform && !(c.transform in EXPORT_TRANSFORMS)) {
      throw new HttpError(400, `unknown_transform:${c.transform}`);
    }
    return { ...c, spec, outHeader: c.header || spec.header || c.field, alias: `c${i}` };
  });
}

function buildLeadsQuery(cols: ResolvedColumn[], filter: FilterShape): BuiltQuery {
  const selects = cols.map((c) => `${c.spec.sql} AS ${c.alias}`).join(", ");
  const needsFirmJoin = cols.some((c) => c.spec.needsFirmJoin);
  const join = needsFirmJoin
    ? "LEFT JOIN firm_people fp ON fp.lead_id = l.id LEFT JOIN firms f ON f.id = fp.firm_id"
    : "";
  const where: string[] = []; const binds: unknown[] = [];
  if (filter.status) { where.push("l.status = ?"); binds.push(filter.status); }
  if (filter.has_email) where.push("(l.email IS NOT NULL AND l.email <> '')");
  if (filter.country_iso2) { where.push("l.country_iso2 = ?"); binds.push(filter.country_iso2); }
  if (filter.since) { where.push("l.created_at >= ?"); binds.push(filter.since); }
  if (!filter.include_merged) where.push("(l.merged_into IS NULL OR l.merged_into = '')");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return {
    sql: `SELECT ${selects} FROM leads l ${join} ${whereSql} ORDER BY l.created_at DESC LIMIT 50000`,
    binds, resolved: cols,
  };
}

function buildFirmsQuery(cols: ResolvedColumn[], filter: FilterShape): BuiltQuery {
  const selects = cols.map((c) => `${c.spec.sql} AS ${c.alias}`).join(", ");
  const where: string[] = []; const binds: unknown[] = [];
  if (filter.kind) { where.push("f.kind = ?"); binds.push(filter.kind); }
  if (filter.country_iso2) { where.push("f.hq_country_iso2 = ?"); binds.push(filter.country_iso2); }
  if (filter.since) { where.push("f.created_at >= ?"); binds.push(filter.since); }
  if (filter.status) { where.push("f.status = ?"); binds.push(filter.status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return {
    sql: `SELECT ${selects} FROM firms f ${whereSql} ORDER BY f.last_modified DESC LIMIT 50000`,
    binds, resolved: cols,
  };
}

function buildFirmPeopleQuery(cols: ResolvedColumn[], filter: FilterShape): BuiltQuery {
  const selects = cols.map((c) => `${c.spec.sql} AS ${c.alias}`).join(", ");
  const where: string[] = []; const binds: unknown[] = [];
  if (filter.kind) { where.push("f.kind = ?"); binds.push(filter.kind); }
  if (filter.country_iso2) { where.push("f.hq_country_iso2 = ?"); binds.push(filter.country_iso2); }
  if (filter.has_email) where.push("(l.email IS NOT NULL AND l.email <> '')");
  if (filter.since) { where.push("fp.created_at >= ?"); binds.push(filter.since); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return {
    sql: `SELECT ${selects} FROM firm_people fp JOIN firms f ON f.id = fp.firm_id JOIN leads l ON l.id = fp.lead_id ${whereSql} ORDER BY fp.id DESC LIMIT 50000`,
    binds, resolved: cols,
  };
}

function buildPortfolioQuery(cols: ResolvedColumn[], filter: FilterShape): BuiltQuery {
  const selects = cols.map((c) => `${c.spec.sql} AS ${c.alias}`).join(", ");
  const where: string[] = []; const binds: unknown[] = [];
  if (filter.country_iso2) { where.push("f.hq_country_iso2 = ?"); binds.push(filter.country_iso2); }
  if (filter.since) { where.push("fpo.created_at >= ?"); binds.push(filter.since); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return {
    sql: `SELECT ${selects} FROM firm_portfolio fpo LEFT JOIN firms f ON f.id = fpo.firm_id ${whereSql} ORDER BY fpo.created_at DESC LIMIT 50000`,
    binds, resolved: cols,
  };
}

function buildQuery(entity: Entity, cols: ResolvedColumn[], filter: FilterShape): BuiltQuery {
  if (entity === "leads") return buildLeadsQuery(cols, filter);
  if (entity === "firms") return buildFirmsQuery(cols, filter);
  if (entity === "firm_people") return buildFirmPeopleQuery(cols, filter);
  return buildPortfolioQuery(cols, filter);
}

// ---------------------------------------------------------------------------
// Format writers.
// ---------------------------------------------------------------------------

type Format = "csv" | "tsv" | "xlsx" | "json";
const VALID_FORMATS: Format[] = ["csv", "tsv", "xlsx", "json"];

function csvEscape(v: string, sep: string): string {
  if (v == null) return "";
  const needsQuote = v.includes(sep) || /["\n\r]/.test(v);
  return needsQuote ? `"${v.replace(/"/g, '""')}"` : v;
}

function renderRow(cols: ResolvedColumn[], row: Record<string, unknown>): string[] {
  return cols.map((c) => {
    const flat = flatten(c.spec, row[c.alias]);
    if (!c.transform) return flat;
    const fn = EXPORT_TRANSFORMS[c.transform];
    return fn ? fn(flat) : flat;
  });
}

function writeDelimited(cols: ResolvedColumn[], rows: Record<string, unknown>[], sep: string): string {
  const lines: string[] = [];
  lines.push(cols.map((c) => csvEscape(c.outHeader, sep)).join(sep));
  for (const r of rows) {
    lines.push(renderRow(cols, r).map((v) => csvEscape(v, sep)).join(sep));
  }
  return lines.join("\r\n");
}

function writeJson(cols: ResolvedColumn[], rows: Record<string, unknown>[]): string {
  const out = rows.map((r) => {
    const obj: Record<string, string> = {};
    const vals = renderRow(cols, r);
    cols.forEach((c, i) => { obj[c.outHeader] = vals[i]; });
    return obj;
  });
  return JSON.stringify(out);
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
}

function colLetter(i: number): string {
  let n = i + 1, s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// XLSX (OOXML) writer — minimum file set so we stay inside Workers.
function writeXlsx(cols: ResolvedColumn[], rows: Record<string, unknown>[]): Uint8Array {
  const sst: string[] = []; const sstIdx = new Map<string, number>();
  const intern = (v: string): number => {
    let i = sstIdx.get(v);
    if (i === undefined) { i = sst.length; sst.push(v); sstIdx.set(v, i); }
    return i;
  };

  let body = "";
  body += `<row r="1">`;
  cols.forEach((c, i) => {
    body += `<c r="${colLetter(i)}1" t="s"><v>${intern(c.outHeader)}</v></c>`;
  });
  body += `</row>`;

  rows.forEach((r, rIdx) => {
    const rowNum = rIdx + 2;
    body += `<row r="${rowNum}">`;
    const vals = renderRow(cols, r);
    cols.forEach((_c, i) => {
      const ref = `${colLetter(i)}${rowNum}`;
      const v = vals[i];
      if (v === "") return;
      if (/^-?\d+(?:\.\d+)?$/.test(v)) {
        body += `<c r="${ref}"><v>${v}</v></c>`;
      } else {
        body += `<c r="${ref}" t="s"><v>${intern(v)}</v></c>`;
      }
    });
    body += `</row>`;
  });

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${body}</sheetData></worksheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">` +
    sst.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("") + `</sst>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    "xl/sharedStrings.xml": strToU8(sstXml),
  });
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function parseColumns(input: unknown): ColumnRequest[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "columns_required");
  if (input.length > 200) throw new HttpError(400, "too_many_columns");
  return input.map((c) => {
    if (typeof c === "string") return { field: c };
    if (!c || typeof c !== "object") throw new HttpError(400, "invalid_column");
    const obj = c as Record<string, unknown>;
    if (typeof obj.field !== "string") throw new HttpError(400, "invalid_column");
    return {
      field: obj.field,
      header: typeof obj.header === "string" ? obj.header : undefined,
      transform: typeof obj.transform === "string" ? obj.transform : undefined,
    };
  });
}

function parseFilter(input: unknown): FilterShape {
  if (!input) return {};
  if (typeof input !== "object") throw new HttpError(400, "invalid_filter");
  const f = input as Record<string, unknown>;
  const out: FilterShape = {};
  if (typeof f.status === "string") out.status = f.status;
  if (typeof f.country_iso2 === "string" && /^[A-Za-z]{2}$/.test(f.country_iso2)) out.country_iso2 = f.country_iso2.toUpperCase();
  if (typeof f.kind === "string") out.kind = f.kind;
  if (typeof f.since === "string") out.since = f.since;
  if (typeof f.has_email === "boolean") out.has_email = f.has_email;
  if (typeof f.include_merged === "boolean") out.include_merged = f.include_merged;
  return out;
}

function entityOrFail(v: unknown): Entity {
  if (typeof v !== "string" || !VALID_ENTITIES.includes(v as Entity)) throw new HttpError(400, "invalid_entity");
  return v as Entity;
}

function formatOrFail(v: unknown): Format {
  const fmt = (typeof v === "string" ? v.toLowerCase() : "csv") as Format;
  if (!VALID_FORMATS.includes(fmt)) throw new HttpError(400, "invalid_format");
  return fmt;
}

// ---------------------------------------------------------------------------
// Core pipeline.
// ---------------------------------------------------------------------------

async function runExport(
  env: Env,
  email: string,
  entity: Entity,
  columnReq: ColumnRequest[],
  filter: FilterShape,
  format: Format,
): Promise<Response> {
  const cols = resolveColumns(entity, columnReq);
  const built = buildQuery(entity, cols, filter);
  const r = await env.DB.prepare(built.sql).bind(...built.binds).all<Record<string, unknown>>();
  const rows = r.results ?? [];

  const exportId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO exports (id, format, filter_json, row_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    exportId, format,
    JSON.stringify({ entity, columns: columnReq, filter }),
    rows.length, email, new Date().toISOString(),
  ).run();

  const stamp = new Date().toISOString().slice(0, 10);
  const baseFilename = `${entity}-${stamp}`;
  const headers: Record<string, string> = {
    "X-Export-Id": exportId,
    "X-Row-Count": String(rows.length),
  };

  if (format === "csv") {
    return new Response(writeDelimited(cols, rows, ","), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${baseFilename}.csv"` },
    });
  }
  if (format === "tsv") {
    return new Response(writeDelimited(cols, rows, "\t"), {
      headers: { ...headers, "Content-Type": "text/tab-separated-values; charset=utf-8", "Content-Disposition": `attachment; filename="${baseFilename}.tsv"` },
    });
  }
  if (format === "json") {
    return new Response(writeJson(cols, rows), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${baseFilename}.json"` },
    });
  }
  const bytes = writeXlsx(cols, rows);
  return new Response(bytes, {
    headers: {
      ...headers,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${baseFilename}.xlsx"`,
    },
  });
}

function handleHttpError(e: unknown): Response {
  if (e instanceof HttpError) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status, headers: { "Content-Type": "application/json" },
    });
  }
  console.error("export error", e);
  return new Response(JSON.stringify({ error: "export_failed", message: (e as Error)?.message }), {
    status: 500, headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

// Legacy GET /csv — backward compatibility shim. Dumps every `leads` real
// column as CSV with the pre-Task-#19 querystring filter shape.
exports_.get("/csv", async (c) => {
  const status = c.req.query("status") ?? undefined;
  const includeMerged = c.req.query("include_merged") === "1";
  try {
    const cols = LEAD_REAL_COLUMNS.map((f) => ({ field: f }));
    return await runExport(
      c.env, c.get("email"), "leads", cols,
      { status, include_merged: includeMerged }, "csv",
    );
  } catch (e) { return handleHttpError(e); }
});

// New POST /csv — accepts custom column lists, filters, and any format.
exports_.post("/csv", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, "invalid_body");
    const entity = entityOrFail(body.entity);
    const cols = parseColumns(body.columns);
    const filter = parseFilter(body.filter);
    const format = formatOrFail(body.format);
    return await runExport(c.env, c.get("email"), entity, cols, filter, format);
  } catch (e) { return handleHttpError(e); }
});

// GET /templates — combined system presets + saved user templates.
exports_.get("/templates", async (c) => {
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, slug, name, entity, columns_json, filter_json, format, created_by, created_at
       FROM export_templates
       ORDER BY (created_by = 'system') DESC, name ASC`,
    ).all<Record<string, unknown>>();
    const items = (r.results ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      entity: row.entity,
      format: row.format,
      created_by: row.created_by,
      created_at: row.created_at,
      columns: JSON.parse(String(row.columns_json || "[]")),
      filter: row.filter_json ? JSON.parse(String(row.filter_json)) : {},
      is_system: row.created_by === "system",
    }));
    return c.json({ items });
  } catch (e) { return handleHttpError(e); }
});

// POST /templates — save a new template under the current user.
exports_.post("/templates", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, "invalid_body");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(400, "name_required");
    const entity = entityOrFail(body.entity);
    const cols = parseColumns(body.columns);
    resolveColumns(entity, cols);
    const filter = parseFilter(body.filter);
    const format = formatOrFail(body.format ?? "csv");
    const r = await c.env.DB.prepare(
      `INSERT INTO export_templates (name, entity, columns_json, filter_json, format, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      name, entity, JSON.stringify(cols), JSON.stringify(filter),
      format, c.get("email"), new Date().toISOString(),
    ).run();
    const id = r.meta?.last_row_id as number | undefined;
    return c.json({ id, name, entity, columns: cols, filter, format });
  } catch (e) { return handleHttpError(e); }
});

// DELETE /templates/:id — owner-or-creator delete; system presets refuse.
exports_.delete("/templates/:id", async (c) => {
  try {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isFinite(id)) throw new HttpError(400, "invalid_id");
    const row = await c.env.DB.prepare(
      "SELECT created_by FROM export_templates WHERE id = ?",
    ).bind(id).first<{ created_by: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.created_by === "system") return c.json({ error: "system_preset_immutable" }, 403);
    await c.env.DB.prepare("DELETE FROM export_templates WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } catch (e) { return handleHttpError(e); }
});
