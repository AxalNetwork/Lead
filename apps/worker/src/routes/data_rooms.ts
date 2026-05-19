// Task #13: Data-room routes.
//
//   POST   /api/data-rooms                       create a new room
//   GET    /api/data-rooms                       list owner-scoped rooms
//   GET    /api/data-rooms/:id                   detail
//   GET    /api/data-rooms/:id/index             categorized doc list + extraction summaries
//   POST   /api/data-rooms/:id/documents         attach a doc {document_id, category?}
//   DELETE /api/data-rooms/:id/documents/:docId  detach a doc
//   DELETE /api/data-rooms/:id                   remove room (cascade detaches)

import { Hono } from "hono";
import type { Env } from "../types";
import { categorizeForDataRoom } from "../services/documents/persist";

export const dataRoomsRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

interface DataRoomRow {
  id: string; owner_email: string; target_entity_id: string | null;
  name: string; description: string | null; created_at: string; updated_at: string;
}

dataRoomsRoute.post("/", async (c) => {
  const email = c.get("email");
  const body = await c.req.json().catch(() => ({})) as { name?: string; description?: string; target_entity_id?: string };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "bad_request", message: "name required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO document_data_rooms (id, owner_email, target_entity_id, name, description) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, email, body.target_entity_id ?? null, name, body.description ?? null).run();
  return c.json({ id, name }, 201);
});

dataRoomsRoute.get("/", async (c) => {
  const email = c.get("email");
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.name, r.description, r.target_entity_id, r.created_at,
            (SELECT COUNT(*) FROM data_room_documents WHERE data_room_id = r.id) AS document_count
       FROM document_data_rooms r WHERE r.owner_email = ? ORDER BY r.created_at DESC`,
  ).bind(email).all();
  return c.json({ data_rooms: rows.results ?? [] });
});

dataRoomsRoute.get("/:id", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const room = await c.env.DB.prepare(
    `SELECT * FROM document_data_rooms WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first<DataRoomRow>();
  if (!room) return c.json({ error: "not_found" }, 404);
  return c.json({ data_room: room });
});

dataRoomsRoute.get("/:id/index", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const room = await c.env.DB.prepare(
    `SELECT id, name, description, target_entity_id FROM document_data_rooms WHERE id = ? AND owner_email = ?`,
  ).bind(id, email).first();
  if (!room) return c.json({ error: "not_found" }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT drd.category, d.id, d.filename, d.detected_kind, d.classifier_confidence,
            d.extraction_status, d.size_bytes, d.page_count, d.created_at,
            (SELECT payload_json FROM document_extractions WHERE document_id = d.id
              ORDER BY created_at DESC LIMIT 1) AS latest_payload_json,
            (SELECT confidence FROM document_extractions WHERE document_id = d.id
              ORDER BY created_at DESC LIMIT 1) AS latest_confidence
       FROM data_room_documents drd
       JOIN documents d ON d.id = drd.document_id
      WHERE drd.data_room_id = ? AND d.owner_email = ?
      ORDER BY drd.category ASC, d.created_at DESC`,
  ).bind(id, email).all();
  const docs = (rows.results ?? []).map((r: Record<string, unknown>) => {
    const payload = r.latest_payload_json ? safeParse(r.latest_payload_json as string) : null;
    return {
      id: r.id, filename: r.filename, category: r.category,
      detected_kind: r.detected_kind, classifier_confidence: r.classifier_confidence,
      extraction_status: r.extraction_status, size_bytes: r.size_bytes,
      page_count: r.page_count, created_at: r.created_at,
      latest_extraction_summary: summarize(r.detected_kind as string | null, payload),
      latest_confidence: r.latest_confidence,
    };
  });
  const grouped: Record<string, typeof docs> = {};
  for (const d of docs) {
    const cat = d.category as string;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(d);
  }
  return c.json({ data_room: room, by_category: grouped, total: docs.length });
});

dataRoomsRoute.post("/:id/documents", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { document_id?: string; category?: string };
  if (!body.document_id) return c.json({ error: "bad_request", message: "document_id required" }, 400);
  const room = await c.env.DB.prepare(`SELECT id FROM document_data_rooms WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!room) return c.json({ error: "not_found" }, 404);
  const doc = await c.env.DB.prepare(`SELECT id, filename, detected_kind FROM documents WHERE id = ? AND owner_email = ?`).bind(body.document_id, email).first<{ id: string; filename: string; detected_kind: string | null }>();
  if (!doc) return c.json({ error: "document_not_found" }, 404);
  const category = body.category ?? categorizeForDataRoom(doc.detected_kind ?? "unknown", doc.filename);
  try {
    await c.env.DB.prepare(
      `INSERT INTO data_room_documents (id, data_room_id, document_id, category) VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, body.document_id, category).run();
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) return c.json({ error: "already_attached" }, 409);
    throw e;
  }
  return c.json({ ok: true, category }, 201);
});

dataRoomsRoute.delete("/:id/documents/:docId", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const docId = c.req.param("docId");
  const room = await c.env.DB.prepare(`SELECT id FROM document_data_rooms WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!room) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(`DELETE FROM data_room_documents WHERE data_room_id = ? AND document_id = ?`).bind(id, docId).run();
  return c.json({ ok: true });
});

dataRoomsRoute.delete("/:id", async (c) => {
  const email = c.get("email");
  const id = c.req.param("id");
  const room = await c.env.DB.prepare(`SELECT id FROM document_data_rooms WHERE id = ? AND owner_email = ?`).bind(id, email).first();
  if (!room) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(`DELETE FROM document_data_rooms WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

function summarize(kind: string | null, payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  switch (kind) {
    case "safe": return { variant: p.variant, cap_usd: p.valuation_cap_usd, discount_pct: p.discount_pct, purchase_amount_usd: p.purchase_amount_usd };
    case "term_sheet": return { pre_money_usd: p.pre_money_usd, post_money_usd: p.post_money_usd, raise_amount_usd: p.raise_amount_usd, security_type: p.security_type };
    case "shareholder_agreement": return { drag_along_threshold_pct: p.drag_along_threshold_pct, board_size: p.board_size };
    case "commercial_contract": return { acv_usd: p.acv_usd, tcv_usd: p.tcv_usd, term_months: p.term_months, auto_renew: p.auto_renew };
    case "nda": return { is_mutual: p.is_mutual, term_months: p.term_months, unusual_clause_flags: p.unusual_clause_flags };
    case "pitch_deck": return { tam_usd: p.tam_usd, ask_amount_usd: p.ask_amount_usd, one_liner: p.one_liner };
    case "financial_model": return { sheet_count: Array.isArray(p.sheet_names) ? (p.sheet_names as unknown[]).length : 0, periods: Array.isArray(p.detected_periods) ? (p.detected_periods as unknown[]).length : 0 };
    default: return null;
  }
}
