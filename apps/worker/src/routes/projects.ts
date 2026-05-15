// Task #47: Projects REST API.
//
// Mounted at /api/projects. Endpoints:
//   GET    /                                       list projects
//   POST   /                                       create + dispatch match
//   GET    /:id                                    detail
//   PATCH  /:id                                    edit + dispatch match
//   DELETE /:id                                    soft-delete
//   GET    /:id/matches?audience=…                 paged matches
//   POST   /:id/matches/:audience/:kind/:eid/status status update + history
//   POST   /:id/matches/:audience/:kind/:eid/notes notes update
//   POST   /:id/recompute                          dispatch workflow
//   GET    /:id/export?audience=…&format=…         CSV / lemlist / hubspot
//   POST   /:id/materials                          R2 upload + optional AI suggest
//   GET    /:id/history                            timeline
//   POST   /:id/suggest                            AI-suggest from text/deck

import { Hono } from "hono";
import type { Env } from "../types";
import {
  listProjects, getProject, insertProject, updateProject, softDeleteProject,
  setProjectEmbeddingMeta, listProjectMatches, updateMatchStatus, updateMatchNotes,
  listProjectHistory, rowToSpec, type ProjectRow,
} from "../projects/repo";
import { embedProject } from "../projects/embed";
import { matchProject } from "../projects/match";
import { suggestFromDeckText } from "../projects/pitch";
import { AUDIENCES } from "../projects/score";

export const projectsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

const PATCHABLE_KEYS = new Set([
  "name","status","kind","one_liner","description","problems_solved","unique_value",
  "stage","funding_status","funding_target",
  "target_industries_json","target_geos_json","target_customer_size_bands_json",
  "audiences_json",
  "customer_persona_ids_json","investor_persona_ids_json","partner_persona_ids_json",
  "hire_persona_ids_json","design_partner_persona_ids_json",
]);

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!PATCHABLE_KEYS.has(k)) continue;
    if (k.endsWith("_json") && (Array.isArray(v) || (v && typeof v === "object"))) out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

async function dispatchMatch(env: Env, projectId: string, ctx: ExecutionContext): Promise<void> {
  if (env.WF_MATCH_PROJECT) {
    try { await env.WF_MATCH_PROJECT.create({ params: { projectId } }); return; }
    catch (e) { console.warn("WF_MATCH_PROJECT.create failed; falling back inline", (e as Error).message); }
  }
  ctx.waitUntil(matchProject(env, projectId).catch((e) => console.error("matchProject inline failed", (e as Error).message)));
}

// ---- list
projectsRoute.get("/", async (c) => {
  const status = c.req.query("status") ?? "active";
  const limit = Number(c.req.query("limit") ?? 200);
  const rows = await listProjects(c.env, { status, limit });
  return c.json({ projects: rows });
});

// ---- create
projectsRoute.post("/", async (c) => {
  const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  if (!name) return c.json({ error: "name_required" }, 400);
  const norm = normalizeBody(body);
  const row = await insertProject(c.env, { ...(norm as Partial<ProjectRow>), name }, c.get("email"));
  // Embed + dispatch match (don't block the response).
  c.executionCtx.waitUntil((async () => {
    try {
      const spec = rowToSpec(row);
      const { vector, text } = await embedProject(c.env, spec);
      if (vector) await setProjectEmbeddingMeta(c.env, row.id, vector.length, text);
    } catch (e) { console.warn("project embed (create) failed", (e as Error).message); }
  })());
  await dispatchMatch(c.env, row.id, c.executionCtx);
  return c.json({ project: row }, 201);
});

// ---- detail
projectsRoute.get("/:id", async (c) => {
  const row = await getProject(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ project: row });
});

// ---- patch
projectsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const norm = normalizeBody(body);
  const row = await updateProject(c.env, id, norm as Partial<ProjectRow>, c.get("email"));
  if (!row) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil((async () => {
    try {
      const spec = rowToSpec(row);
      const { vector, text } = await embedProject(c.env, spec);
      if (vector) await setProjectEmbeddingMeta(c.env, row.id, vector.length, text);
    } catch (e) { console.warn("project embed (patch) failed", (e as Error).message); }
  })());
  await dispatchMatch(c.env, id, c.executionCtx);
  return c.json({ project: row });
});

// ---- soft-delete
projectsRoute.delete("/:id", async (c) => {
  const ok = await softDeleteProject(c.env, c.req.param("id"), c.get("email"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---- matches
projectsRoute.get("/:id/matches", async (c) => {
  const id = c.req.param("id");
  const audience = c.req.query("audience") ?? "customer";
  if (!AUDIENCES.includes(audience as never)) return c.json({ error: "bad_audience" }, 400);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const status = c.req.query("status") ?? undefined;
  const fitMin = c.req.query("fit_min") ? Number(c.req.query("fit_min")) : undefined;
  const r = await listProjectMatches(c.env, id, audience, { limit, offset, status, fit_min: fitMin });
  return c.json({ matches: r.rows, total: r.total });
});

// ---- match status
projectsRoute.post("/:id/matches/:audience/:kind/:eid/status", async (c) => {
  const body = (await c.req.json<{ status?: string }>().catch(() => ({}))) as { status?: string };
  const status = String(body.status ?? "");
  if (!["new","shortlisted","contacted","replied","qualified","won","lost","snoozed"].includes(status)) {
    return c.json({ error: "bad_status" }, 400);
  }
  const ok = await updateMatchStatus(c.env, c.req.param("id"), c.req.param("audience"), c.req.param("kind"), c.req.param("eid"), status, c.get("email"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---- match notes
projectsRoute.post("/:id/matches/:audience/:kind/:eid/notes", async (c) => {
  const body = (await c.req.json<{ notes?: string }>().catch(() => ({}))) as { notes?: string };
  const notes = String(body.notes ?? "").slice(0, 4000);
  const ok = await updateMatchNotes(c.env, c.req.param("id"), c.req.param("audience"), c.req.param("kind"), c.req.param("eid"), notes);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---- manual recompute
projectsRoute.post("/:id/recompute", async (c) => {
  const id = c.req.param("id");
  const row = await getProject(c.env, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  await dispatchMatch(c.env, id, c.executionCtx);
  return c.json({ ok: true, dispatched: true });
});

// ---- audience-filtered export. Drift: delegates to a minimal CSV
// emitter inline; the existing /api/exports builder takes a different
// shape (entity-centric + custom columns) and a deeper integration is
// deferred to a follow-up.
projectsRoute.get("/:id/export", async (c) => {
  const id = c.req.param("id");
  const audience = c.req.query("audience") ?? "customer";
  if (!AUDIENCES.includes(audience as never)) return c.json({ error: "bad_audience" }, 400);
  const format = (c.req.query("format") ?? "csv").toLowerCase();
  const fitMin = c.req.query("fit_min") ? Number(c.req.query("fit_min")) : undefined;
  const status = c.req.query("status") ?? undefined;
  const { rows } = await listProjectMatches(c.env, id, audience, { limit: 500, offset: 0, status, fit_min: fitMin });
  const headers = ["entity_kind","entity_id","rank","fit_score","persona_score","semantic_score","overlay_score","status","pitch_angle"];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.entity_kind, r.entity_id, String(r.rank),
      r.fit_score.toFixed(2), r.persona_score.toFixed(2), r.semantic_score.toFixed(2), r.overlay_score.toFixed(2),
      r.status, esc(r.pitch_angle ?? ""),
    ].join(","));
  }
  const body = lines.join("\n");
  const filename = `project-${id}-${audience}.${format === "tsv" ? "tsv" : "csv"}`;
  return new Response(body, {
    headers: {
      "Content-Type": format === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ---- materials upload (R2 UPLOADS) + optional AI suggest
projectsRoute.post("/:id/materials", async (c) => {
  const id = c.req.param("id");
  const row = await getProject(c.env, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!c.env.UPLOADS) return c.json({ error: "uploads_not_configured" }, 500);
  const ct = c.req.header("Content-Type") ?? "";
  if (!ct.startsWith("multipart/form-data")) return c.json({ error: "expected_multipart" }, 400);
  const form = await c.req.formData();
  const fileEntry = form.get("file") as unknown as { name?: string; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!fileEntry || typeof fileEntry.arrayBuffer !== "function") return c.json({ error: "file_required" }, 400);
  const filename = fileEntry.name || "upload.bin";
  const mime = fileEntry.type || "application/octet-stream";
  const key = `projects/${id}/${crypto.randomUUID()}-${filename}`;
  const buf = await fileEntry.arrayBuffer();
  await c.env.UPLOADS.put(key, buf, { httpMetadata: { contentType: mime } });
  const materials = (() => { try { return JSON.parse(row.materials_json ?? "[]"); } catch { return []; } })();
  materials.push({ key, filename, mime, size: buf.byteLength, uploaded_at: new Date().toISOString() });
  await c.env.DB.prepare(`UPDATE projects SET materials_json = ?, updated_at = ?, last_modified = ? WHERE id = ?`)
    .bind(JSON.stringify(materials), new Date().toISOString(), new Date().toISOString(), id).run();

  let suggestions: Record<string, unknown> | null = null;
  if (form.get("suggest") === "1") {
    // Drift: real PDF extraction goes through the AI OCR model + a
    // PDF→text step; we accept either a `text` form field as a
    // shortcut or ask the caller to POST /:id/suggest after converting.
    const text = String(form.get("text") ?? "");
    if (text.trim()) {
      suggestions = await suggestFromDeckText(c.env, text);
      if (suggestions) {
        await c.env.DB.prepare(`UPDATE projects SET ai_suggestions_json = ? WHERE id = ?`).bind(JSON.stringify(suggestions), id).run();
      }
    }
  }
  return c.json({ ok: true, key, materials, suggestions });
});

// ---- history (timeline)
projectsRoute.get("/:id/history", async (c) => {
  const items = await listProjectHistory(c.env, c.req.param("id"), Number(c.req.query("limit") ?? 200));
  return c.json({ history: items });
});

// ---- AI suggest from arbitrary deck text (called by the wizard)
projectsRoute.post("/:id/suggest", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json<{ text?: string }>().catch(() => ({}))) as { text?: string };
  const text = String(body.text ?? "");
  if (!text.trim()) return c.json({ error: "text_required" }, 400);
  const suggestions = await suggestFromDeckText(c.env, text);
  if (suggestions) {
    await c.env.DB.prepare(`UPDATE projects SET ai_suggestions_json = ? WHERE id = ?`).bind(JSON.stringify(suggestions), id).run();
  }
  return c.json({ suggestions });
});
