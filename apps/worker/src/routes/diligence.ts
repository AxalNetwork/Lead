// Task #6: Diligence Checklist Runner — API surface.
//
//   GET    /api/diligence/templates              list (system + owner-scoped)
//   POST   /api/diligence/templates              create owner-scoped template
//   POST   /api/diligence/runs                   start a run
//   GET    /api/diligence/runs                   list runs (owner-scoped, optional ?target=)
//   GET    /api/diligence/runs/:id               run detail + results
//   GET    /api/diligence/runs/:id/report.md     markdown export
//   GET    /api/diligence/runs/:id/report.json   JSON evidence bundle
//   GET    /api/diligence/runs/:id/report.pdf    PDF export (canonical pdfResponse)
//   PATCH  /api/diligence/runs/:id/results/:rid  flip flagged_for_human
//   POST   /api/diligence/runs/:id/rerun-failed  rerun fail|caution|needs_human
//
// All routes sit behind accessGuard at the api.use("/api/*") layer
// (see index.ts). Owner-scoped via c.var.email.

import { Hono } from "hono";
import type { Env } from "../types";
import { createRun, executeRunLoop, createRerunFailedPlan, ensureDefaultTemplate } from "../services/diligence/runner";
import { DEFAULT_TEMPLATE_KEYS, getCheck } from "../services/diligence/registry";
import { buildMarkdownReport, buildJsonBundle, buildPdfInputs, type PersistedResult, type PersistedRun } from "../services/diligence/report";
import { pdfResponse } from "./dashboards_pdf";
import type { CheckStatus, Section } from "../services/diligence/types";

export const diligenceRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

// ---- Templates ----

diligenceRoute.get("/templates", async (c) => {
  await ensureDefaultTemplate(c.env);
  const owner = c.var.email;
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, name, description, owner_email, is_system, check_keys_json, created_at, updated_at
         FROM diligence_templates
        WHERE is_system = 1 OR owner_email = ?
        ORDER BY is_system DESC, name ASC`,
    ).bind(owner).all<Record<string, unknown>>();
    const items = (r.results ?? []).map((row) => {
      let keys: string[] = [];
      try { keys = JSON.parse(String(row.check_keys_json)); } catch { keys = []; }
      return { ...row, check_keys_json: undefined, check_keys: keys };
    });
    return c.json({ items });
  } catch {
    return c.json({ items: [] });
  }
});

diligenceRoute.post("/templates", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string; check_keys?: string[] };
  if (!body.name || typeof body.name !== "string") return c.json({ error: "name_required" }, 400);
  const keys = Array.isArray(body.check_keys) && body.check_keys.length > 0
    ? body.check_keys.filter((k) => typeof k === "string")
    : DEFAULT_TEMPLATE_KEYS;
  // Reject unknown keys so an operator can't create a template whose checks won't run.
  const unknown = keys.filter((k) => !getCheck(k));
  if (unknown.length) return c.json({ error: "unknown_check_keys", unknown }, 400);
  const id = `tmpl_${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    `INSERT INTO diligence_templates (id, name, description, owner_email, is_system, check_keys_json)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).bind(id, body.name, body.description ?? null, c.var.email, JSON.stringify(keys)).run();
  return c.json({ id, name: body.name, check_keys: keys });
});

// Also expose the in-process check registry so the UI can list available
// check_keys + titles when authoring custom templates.
diligenceRoute.get("/checks", async (c) => {
  const items = [...DEFAULT_TEMPLATE_KEYS].map((k) => {
    const def = getCheck(k);
    return def ? { key: def.key, section: def.section, title: def.title, severity: def.severity } : null;
  }).filter((x) => x);
  return c.json({ items });
});

// ---- Runs ----

diligenceRoute.post("/runs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { template_id?: string; target_entity_id?: string };
  if (!body.target_entity_id || typeof body.target_entity_id !== "string") return c.json({ error: "target_entity_id_required" }, 400);
  const templateId = body.template_id || (await ensureDefaultTemplate(c.env));
  // Verify the template is visible to this caller.
  const tmpl = await c.env.DB.prepare(
    `SELECT id, owner_email, is_system FROM diligence_templates WHERE id = ?`,
  ).bind(templateId).first<{ id: string; owner_email: string | null; is_system: number }>();
  if (!tmpl) return c.json({ error: "template_not_found" }, 404);
  if (tmpl.is_system !== 1 && tmpl.owner_email && tmpl.owner_email !== c.var.email) {
    return c.json({ error: "forbidden_template" }, 403);
  }
  try {
    // Create the run row synchronously so the client gets a run_id immediately
    // and can navigate to the detail page (which polls for live progress
    // while status is queued|running). The heavy per-check loop runs in the
    // background via ctx.waitUntil so the POST returns in <100ms regardless
    // of how many checks the template carries.
    const plan = await createRun(c.env, { template_id: templateId, target_entity_id: body.target_entity_id, triggered_by: c.var.email });
    c.executionCtx.waitUntil(
      executeRunLoop(c.env, plan).then(() => undefined).catch((e) => {
        console.warn("diligence run loop failed", plan.run_id, (e as Error).message);
      }),
    );
    return c.json({ run_id: plan.run_id, status: "queued", checks_total: plan.check_keys.length }, 202);
  } catch (e) {
    return c.json({ error: "run_failed", message: (e as Error).message }, 500);
  }
});

diligenceRoute.get("/runs", async (c) => {
  const target = c.req.query("target");
  const args: Array<string> = [c.var.email];
  let where = "triggered_by = ?";
  if (target) { where += " AND target_entity_id = ?"; args.push(target); }
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, template_id, target_entity_id, triggered_by, status, overall_score,
              checks_total, checks_completed, by_status_json, parent_run_id,
              started_at, finished_at, created_at
         FROM diligence_runs
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 200`,
    ).bind(...args).all<Record<string, unknown>>();
    const items = (r.results ?? []).map((row) => {
      let by: Record<string, number> = {};
      try { by = row.by_status_json ? JSON.parse(String(row.by_status_json)) : {}; } catch { by = {}; }
      return { ...row, by_status_json: undefined, by_status: by };
    });
    return c.json({ items });
  } catch {
    return c.json({ items: [] });
  }
});

async function loadRun(env: Env, runId: string, owner: string): Promise<{ run: PersistedRun; results: PersistedResult[] } | { error: "not_found" | "forbidden" }> {
  const row = await env.DB.prepare(
    `SELECT id, template_id, target_entity_id, triggered_by, status, overall_score,
            checks_total, checks_completed, by_status_json, parent_run_id,
            started_at, finished_at, created_at
       FROM diligence_runs WHERE id = ?`,
  ).bind(runId).first<Record<string, unknown>>();
  if (!row) return { error: "not_found" };
  if (row.triggered_by !== owner) return { error: "forbidden" };
  let by: Record<string, number> = {};
  try { by = row.by_status_json ? JSON.parse(String(row.by_status_json)) : {}; } catch { by = {}; }
  const run: PersistedRun = {
    id: String(row.id),
    template_id: String(row.template_id),
    target_entity_id: String(row.target_entity_id),
    triggered_by: String(row.triggered_by),
    status: String(row.status),
    overall_score: row.overall_score == null ? null : Number(row.overall_score),
    checks_total: Number(row.checks_total),
    checks_completed: Number(row.checks_completed),
    by_status: by,
    parent_run_id: row.parent_run_id ? String(row.parent_run_id) : null,
    started_at: row.started_at ? String(row.started_at) : null,
    finished_at: row.finished_at ? String(row.finished_at) : null,
    created_at: String(row.created_at),
  };
  const r = await env.DB.prepare(
    `SELECT id, run_id, check_key, section, title, status, severity, confidence,
            finding_md, evidence_json, flagged_for_human, duration_ms, created_at
       FROM diligence_check_results
      WHERE run_id = ?
      ORDER BY created_at ASC`,
  ).bind(runId).all<Record<string, unknown>>();
  const results: PersistedResult[] = (r.results ?? []).map((row) => {
    let evidence: string[] = [];
    try { evidence = row.evidence_json ? JSON.parse(String(row.evidence_json)) : []; } catch { evidence = []; }
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      check_key: String(row.check_key),
      section: String(row.section) as Section,
      title: String(row.title),
      status: String(row.status) as CheckStatus,
      severity: String(row.severity),
      confidence: Number(row.confidence),
      finding_md: String(row.finding_md),
      evidence,
      flagged_for_human: Number(row.flagged_for_human ?? 0),
      duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
      created_at: String(row.created_at),
    };
  });
  return { run, results };
}

diligenceRoute.get("/runs/:id", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  return c.json({ run: got.run, results: got.results });
});

diligenceRoute.get("/runs/:id/report.md", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  const md = buildMarkdownReport(got.run, got.results);
  return new Response(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="diligence_${got.run.id}.md"`,
    },
  });
});

diligenceRoute.get("/runs/:id/report.json", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  return c.json(buildJsonBundle(got.run, got.results));
});

diligenceRoute.get("/runs/:id/report.pdf", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  const inputs = buildPdfInputs(got.run, got.results);
  return pdfResponse(inputs.rows, inputs.headers, inputs.filename, inputs.title, inputs.subtitle);
});

diligenceRoute.patch("/runs/:id/results/:rid", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  const body = (await c.req.json().catch(() => ({}))) as { flagged_for_human?: boolean };
  const flag = body.flagged_for_human ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE diligence_check_results SET flagged_for_human = ? WHERE id = ? AND run_id = ?`,
  ).bind(flag, c.req.param("rid"), c.req.param("id")).run();
  return c.json({ ok: true });
});

diligenceRoute.post("/runs/:id/rerun-failed", async (c) => {
  const got = await loadRun(c.env, c.req.param("id"), c.var.email);
  if ("error" in got) return c.json({ error: got.error }, got.error === "not_found" ? 404 : 403);
  const plan = await createRerunFailedPlan(c.env, { parent_run_id: c.req.param("id"), triggered_by: c.var.email });
  if (!plan) return c.json({ error: "nothing_to_rerun" }, 400);
  c.executionCtx.waitUntil(
    executeRunLoop(c.env, plan).then(() => undefined).catch((e) => {
      console.warn("diligence rerun loop failed", plan.run_id, (e as Error).message);
    }),
  );
  return c.json({ run_id: plan.run_id, status: "queued", checks_total: plan.check_keys.length }, 202);
});
