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
import { suggestFromDeckText, extractTextFromUpload } from "../projects/pitch";
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

// Map convenience UI field names to the underlying *_json columns so
// the workspace edit panel and suggestion-apply flow can send plain
// `target_industries: [...]` instead of pre-stringified `_json` keys.
const ALIAS_TO_JSON: Record<string, string> = {
  target_industries: "target_industries_json",
  target_geos: "target_geos_json",
  target_customer_size_bands: "target_customer_size_bands_json",
  audiences: "audiences_json",
  customer_persona_ids: "customer_persona_ids_json",
  investor_persona_ids: "investor_persona_ids_json",
  partner_persona_ids: "partner_persona_ids_json",
  hire_persona_ids: "hire_persona_ids_json",
  design_partner_persona_ids: "design_partner_persona_ids_json",
};

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let [k, v] of Object.entries(body)) {
    if (ALIAS_TO_JSON[k]) k = ALIAS_TO_JSON[k];
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
  const country = c.req.query("country") ?? undefined;
  const fitMin = c.req.query("fit_min") ? Number(c.req.query("fit_min")) : undefined;
  const r = await listProjectMatches(c.env, id, audience, { limit, offset, status, country, fit_min: fitMin });
  return c.json({ matches: r.rows, total: r.total });
});

// ---- bulk shortlist (writes status='shortlisted' for matching keys)
projectsRoute.post("/:id/matches/:audience/bulk-status", async (c) => {
  const id = c.req.param("id");
  const audience = c.req.param("audience");
  if (!AUDIENCES.includes(audience as never)) return c.json({ error: "bad_audience" }, 400);
  const body = (await c.req.json<{ keys?: Array<{ kind: string; id: string }>; status?: string }>().catch(() => ({}))) as { keys?: Array<{ kind: string; id: string }>; status?: string };
  const status = String(body.status ?? "shortlisted");
  if (!["new","shortlisted","contacted","replied","qualified","won","lost","snoozed"].includes(status)) {
    return c.json({ error: "bad_status" }, 400);
  }
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
  let updated = 0;
  for (const k of keys) {
    const ok = await updateMatchStatus(c.env, id, audience, k.kind, k.id, status, c.get("email"));
    if (ok) updated += 1;
  }
  return c.json({ ok: true, updated });
});

// ---- practice-pitch generator: returns a 4-paragraph cold email tailored
// to a specific match. Server-side AI call (cached). Defaults to the
// stored pitch_angle when AI is unavailable.
projectsRoute.post("/:id/matches/:audience/:kind/:eid/practice-pitch", async (c) => {
  const id = c.req.param("id");
  const audience = c.req.param("audience");
  if (!AUDIENCES.includes(audience as never)) return c.json({ error: "bad_audience" }, 400);
  const project = await getProject(c.env, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  const m = await c.env.DB.prepare(
    `SELECT pitch_angle, components_json FROM project_matches
       WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`,
  ).bind(id, audience, c.req.param("kind"), c.req.param("eid")).first<{ pitch_angle: string | null; components_json: string | null }>();
  if (!m) return c.json({ error: "match_not_found" }, 404);
  let comp: Record<string, unknown> = {}; try { comp = JSON.parse(m.components_json ?? "{}"); } catch {}
  const explanation = String(comp.explanation ?? "");
  if (!c.env.AI) {
    return c.json({ email: { subject: `${project.name} — quick intro`, body: m.pitch_angle ?? explanation ?? "(no AI available)" } });
  }
  try {
    const model = c.env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
    const res = (await c.env.AI.run(model, {
      messages: [
        { role: "system", content: 'Write a 4-paragraph cold email. Return strict JSON {"subject": ..., "body": ...}. No preamble.' },
        { role: "user", content: `Project: ${project.name}\nOne-liner: ${project.one_liner ?? ""}\nAudience: ${audience}\nWhy this fits: ${explanation}\nPitch angle: ${m.pitch_angle ?? ""}\nWrite a personalized 4-paragraph cold email.` },
      ],
    })) as { response?: string };
    const raw = (res?.response ?? "").trim();
    const j = raw.match(/\{[\s\S]*\}/);
    let parsed: { subject?: string; body?: string } = {};
    if (j) { try { parsed = JSON.parse(j[0]); } catch {} }
    return c.json({ email: { subject: parsed.subject ?? `${project.name} — quick intro`, body: parsed.body ?? raw } });
  } catch (e) {
    return c.json({ email: { subject: `${project.name} — quick intro`, body: m.pitch_angle ?? explanation }, error: (e as Error).message });
  }
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

// ---- audience-filtered export. Hydrates the matched entity rows
// (lead/account/firm/company) and emits CSV in one of three column
// templates: `csv` (internal/full), `lemlist`
// (email/first_name/last_name/company_name/picture/icebreaker), or
// `hubspot` (Email/First Name/Last Name/Company/Job Title/HubSpot
// Owner). Lemlist's `icebreaker` column is filled from pitch_angle.
async function hydrateForExport(
  env: Env,
  rows: Array<{ entity_kind: string; entity_id: string; pitch_angle: string | null; fit_score: number; rank: number; status: string }>,
): Promise<Array<Record<string, string>>> {
  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byKind.get(r.entity_kind) ?? [];
    arr.push(r.entity_id);
    byKind.set(r.entity_kind, arr);
  }
  const facts = new Map<string, Record<string, unknown>>();
  for (const [kind, ids] of byKind) {
    if (!ids.length) continue;
    const ph = ids.map(() => "?").join(",");
    let q = "";
    if (kind === "lead") q = `SELECT id, name, email, org, title FROM leads WHERE id IN (${ph})`;
    else if (kind === "account") q = `SELECT id, name, domain, NULL AS email, NULL AS title FROM accounts WHERE id IN (${ph})`;
    else if (kind === "firm") q = `SELECT id, name, NULL AS domain, NULL AS email, NULL AS title FROM firms WHERE id IN (${ph})`;
    else if (kind === "company") q = `SELECT id, name, domain, NULL AS email, NULL AS title FROM companies WHERE id IN (${ph})`;
    else continue;
    try {
      const r = await env.DB.prepare(q).bind(...ids).all<Record<string, unknown>>();
      for (const row of r.results ?? []) facts.set(`${kind}:${row.id}`, row);
    } catch (e) { console.warn("export hydrate failed", kind, (e as Error).message); }
  }
  const splitName = (full: string) => {
    const parts = String(full ?? "").trim().split(/\s+/);
    if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  };
  const out: Array<Record<string, string>> = [];
  for (const r of rows) {
    const f = facts.get(`${r.entity_kind}:${r.entity_id}`) ?? {};
    const name = String(f.name ?? "");
    const { first, last } = splitName(name);
    const email = String(f.email ?? "");
    const company = r.entity_kind === "lead" ? String(f.org ?? "") : name;
    const title = String(f.title ?? "");
    out.push({
      entity_kind: r.entity_kind, entity_id: r.entity_id,
      name, email, first_name: first, last_name: last,
      company_name: company, title,
      rank: String(r.rank), fit_score: r.fit_score.toFixed(2),
      status: r.status, pitch_angle: r.pitch_angle ?? "",
    });
  }
  return out;
}

function emitCsv(headers: string[], data: Array<Record<string, string>>, headerMap?: Record<string, string>): string {
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const headerRow = headers.map((h) => esc(headerMap?.[h] ?? h)).join(",");
  const lines = [headerRow];
  for (const row of data) lines.push(headers.map((h) => esc(row[h] ?? "")).join(","));
  return lines.join("\n");
}

projectsRoute.get("/:id/export", async (c) => {
  const id = c.req.param("id");
  const audience = c.req.query("audience") ?? "customer";
  if (!AUDIENCES.includes(audience as never)) return c.json({ error: "bad_audience" }, 400);
  const format = (c.req.query("format") ?? "csv").toLowerCase();
  const fitMin = c.req.query("fit_min") ? Number(c.req.query("fit_min")) : undefined;
  const status = c.req.query("status") ?? undefined;
  const country = c.req.query("country") ?? undefined;
  const { rows } = await listProjectMatches(c.env, id, audience, { limit: 1000, offset: 0, status, country, fit_min: fitMin });
  const data = await hydrateForExport(c.env, rows);

  let body = "";
  let mime = "text/csv; charset=utf-8";
  let ext = "csv";
  if (format === "lemlist") {
    body = emitCsv(["email","first_name","last_name","company_name","title","pitch_angle"], data, { pitch_angle: "icebreaker" });
  } else if (format === "hubspot") {
    body = emitCsv(["email","first_name","last_name","company_name","title","pitch_angle"], data, {
      email: "Email", first_name: "First Name", last_name: "Last Name",
      company_name: "Company", title: "Job Title", pitch_angle: "Notes",
    });
  } else if (format === "tsv") {
    const headers = ["entity_kind","entity_id","rank","fit_score","status","name","email","title","company_name","pitch_angle"];
    body = headers.join("\t") + "\n" + data.map((r) => headers.map((h) => String(r[h] ?? "").replace(/\t|\n/g, " ")).join("\t")).join("\n");
    mime = "text/tab-separated-values; charset=utf-8"; ext = "tsv";
  } else {
    body = emitCsv(["entity_kind","entity_id","rank","fit_score","status","name","email","title","company_name","pitch_angle"], data);
  }
  const filename = `project-${id}-${audience}-${format}.${ext}`;
  return new Response(body, {
    headers: {
      "Content-Type": mime,
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
    // Prefer caller-provided extracted text (faster, no parsing risk).
    // Otherwise extract from the uploaded buffer (PDF text-stream parse,
    // text/* decode, or printable-ASCII fallback) and feed to the LLM.
    let text = String(form.get("text") ?? "");
    if (!text.trim()) {
      try { text = await extractTextFromUpload(buf, mime, filename); }
      catch (e) { console.warn("extractTextFromUpload failed", (e as Error).message); }
    }
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
