import { Hono } from "hono";
import type { Env } from "../types";

export const exports_ = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const FLAT_COLUMNS = [
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
  "created_at", "updated_at",
];

const JSON_ARRAY_COLS = new Set([
  "alt_emails_json", "languages_json", "tags_json", "sector_focus_json",
  "companies_json", "board_seats_json", "awards_json", "exits_json",
]);

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function flatten(col: string, raw: unknown): string {
  if (!JSON_ARRAY_COLS.has(col)) return raw == null ? "" : String(raw);
  if (raw == null || raw === "") return "";
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr)) {
      return arr
        .map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)))
        .join("|");
    }
    return String(raw);
  } catch {
    return String(raw);
  }
}

exports_.get("/csv", async (c) => {
  const status = c.req.query("status");
  const includeMerged = c.req.query("include_merged") === "1";

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    wheres.push("status = ?");
    binds.push(status);
  }
  if (!includeMerged) {
    wheres.push("(merged_into IS NULL OR merged_into = '')");
  }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

  const stmt = c.env.DB.prepare(
    `SELECT ${FLAT_COLUMNS.join(", ")} FROM leads ${whereSql} ORDER BY created_at DESC`,
  ).bind(...binds);
  const r = await stmt.all<Record<string, unknown>>();
  const rows = r.results ?? [];

  const lines: string[] = [FLAT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(FLAT_COLUMNS.map((col) => csvEscape(flatten(col, row[col]))).join(","));
  }
  const csv = lines.join("\n");

  const exportId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO exports (id, format, filter_json, row_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      exportId,
      "csv",
      JSON.stringify({ status: status ?? null, include_merged: includeMerged }),
      rows.length,
      c.get("email"),
      new Date().toISOString(),
    )
    .run();

  const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Id": exportId,
      "X-Row-Count": String(rows.length),
    },
  });
});
