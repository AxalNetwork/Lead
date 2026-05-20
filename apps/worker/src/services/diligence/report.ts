// Task #6: report builders — markdown summary, JSON evidence bundle.
//
// PDF rendering goes through the canonical `buildPdf` / `pdfResponse`
// helpers in `routes/dashboards_pdf.ts` per the Task #4 PDF-pipeline
// decision in replit.md. This file builds the structured rows the
// route handler hands to `pdfResponse`; it does NOT spawn a parallel
// PDF implementation.

import type { CheckStatus, Section } from "./types";

export interface PersistedResult {
  id: string;
  run_id: string;
  check_key: string;
  section: Section;
  title: string;
  status: CheckStatus;
  severity: string;
  confidence: number;
  finding_md: string;
  evidence: string[];
  flagged_for_human: number;
  duration_ms: number | null;
  created_at: string;
}

export interface PersistedRun {
  id: string;
  template_id: string;
  target_entity_id: string;
  triggered_by: string;
  status: string;
  overall_score: number | null;
  checks_total: number;
  checks_completed: number;
  by_status: Record<string, number>;
  parent_run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const SECTIONS: Section[] = ["corporate", "founders", "market", "product", "traction", "team", "regulatory", "financial", "ip"];

function statusBadge(s: CheckStatus): string {
  switch (s) {
    case "pass": return "✓ pass";
    case "fail": return "✗ fail";
    case "caution": return "⚠ caution";
    case "n/a": return "— n/a";
    case "needs_human": return "? needs_human";
  }
}

export function buildMarkdownReport(run: PersistedRun, results: PersistedResult[]): string {
  const lines: string[] = [];
  lines.push(`# Diligence report — ${run.target_entity_id}`);
  lines.push("");
  lines.push(`- **Run:** \`${run.id}\``);
  lines.push(`- **Template:** \`${run.template_id}\``);
  lines.push(`- **Triggered by:** ${run.triggered_by}`);
  lines.push(`- **Status:** ${run.status}`);
  lines.push(`- **Overall score:** ${run.overall_score == null ? "—" : run.overall_score.toFixed(1) + " / 100"}`);
  lines.push(`- **Checks:** ${run.checks_completed}/${run.checks_total}`);
  const by = run.by_status ?? {};
  lines.push(`- **By status:** pass=${by.pass ?? 0}, fail=${by.fail ?? 0}, caution=${by.caution ?? 0}, n/a=${by["n/a"] ?? 0}, needs_human=${by.needs_human ?? 0}`);
  if (run.parent_run_id) lines.push(`- **Re-run of:** \`${run.parent_run_id}\``);
  lines.push("");
  for (const section of SECTIONS) {
    const sectionResults = results.filter((r) => r.section === section);
    if (sectionResults.length === 0) continue;
    lines.push(`## ${section[0].toUpperCase()}${section.slice(1)}`);
    lines.push("");
    for (const r of sectionResults) {
      lines.push(`### ${r.title} — ${statusBadge(r.status)}`);
      lines.push("");
      lines.push(`- key: \`${r.check_key}\` · severity: ${r.severity} · confidence: ${r.confidence.toFixed(2)}`);
      lines.push("");
      lines.push(r.finding_md);
      if (r.evidence.length) {
        lines.push("");
        lines.push("**Evidence:**");
        for (const url of r.evidence) lines.push(`- ${url}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function buildJsonBundle(run: PersistedRun, results: PersistedResult[]): unknown {
  return {
    run: {
      id: run.id,
      template_id: run.template_id,
      target_entity_id: run.target_entity_id,
      triggered_by: run.triggered_by,
      status: run.status,
      overall_score: run.overall_score,
      checks_total: run.checks_total,
      checks_completed: run.checks_completed,
      by_status: run.by_status,
      parent_run_id: run.parent_run_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      created_at: run.created_at,
    },
    results: results.map((r) => ({
      check_key: r.check_key,
      section: r.section,
      title: r.title,
      status: r.status,
      severity: r.severity,
      confidence: r.confidence,
      finding_md: r.finding_md,
      evidence: r.evidence,
      flagged_for_human: r.flagged_for_human === 1,
      duration_ms: r.duration_ms,
      created_at: r.created_at,
    })),
  };
}

// Build inputs for the canonical buildPdf helper in routes/dashboards_pdf.ts.
// Each diligence row becomes one PDF row; long markdown is truncated to
// keep the PDF readable (the markdown + JSON exports carry the full text).
// Headers + rows shape matches `pdfResponse(rows, headers, filename, title, subtitle)`.
export function buildPdfInputs(run: PersistedRun, results: PersistedResult[]): {
  title: string;
  subtitle: string;
  headers: string[];
  rows: Record<string, unknown>[];
  filename: string;
} {
  const title = `Diligence Report — ${run.target_entity_id}`;
  const subtitle = `Run ${run.id} · score ${run.overall_score == null ? "—" : run.overall_score.toFixed(1)} · ${run.checks_completed}/${run.checks_total} checks`;
  const headers = ["Section", "Check", "Status", "Severity", "Finding"];
  const rows: Record<string, unknown>[] = results.map((r) => ({
    Section: r.section,
    Check: r.title,
    Status: r.status,
    Severity: r.severity,
    Finding: r.finding_md.replace(/[*_`#]/g, "").replace(/\s+/g, " ").slice(0, 140),
  }));
  const filename = `diligence_${run.id}`;
  return { title, subtitle, headers, rows, filename };
}
