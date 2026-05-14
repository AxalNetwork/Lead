import { Hono } from "hono";
import type { Env } from "../types";

export const exports_ = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

exports_.get("/csv", async (c) => {
  const status = c.req.query("status");
  const stmt = status
    ? c.env.DB.prepare(
        "SELECT id, name, email, org, title, category, source_domain, source_url, status, verified, flagged, approved_at, approved_by, created_at FROM leads WHERE status = ? ORDER BY created_at DESC",
      ).bind(status)
    : c.env.DB.prepare(
        "SELECT id, name, email, org, title, category, source_domain, source_url, status, verified, flagged, approved_at, approved_by, created_at FROM leads ORDER BY created_at DESC",
      );
  const r = await stmt.all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const headers = [
    "id", "name", "email", "org", "title", "category",
    "source_domain", "source_url", "status", "verified",
    "flagged", "approved_at", "approved_by", "created_at",
  ];
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  const csv = lines.join("\n");

  const exportId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO exports (id, format, filter_json, row_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      exportId,
      "csv",
      JSON.stringify({ status: status ?? null }),
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
