// Field-level diff between two canonical summaries.

import type { CanonicalSummary } from "./summary";

export interface FieldDiff {
  field: string;
  old: unknown;
  new: unknown;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    for (const k of ka) {
      if (!eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

// Fields that participate in delta evaluation. Order is preserved so
// the rendered diff lists facts in a predictable order.
const FIELDS: (keyof CanonicalSummary)[] = [
  "display_name",
  "employer",
  "employer_entity_id",
  "title",
  "role",
  "city",
  "country",
  "sectors",
  "stages",
  "check_size_min_usd",
  "check_size_max_usd",
  "portfolio_count",
  "last_news_at",
  "last_post_at",
  "handles_count",
  "dd_risk_score",
  "dd_findings_by_severity",
  "trust_score",
  "fit_max_score",
  "intent_score",
];

export function diffSummaries(oldS: CanonicalSummary | null, newS: CanonicalSummary): FieldDiff[] {
  const out: FieldDiff[] = [];
  if (!oldS) return out; // baseline snapshot — no diff emitted (spec)
  for (const f of FIELDS) {
    const a = oldS[f];
    const b = newS[f];
    if (!eq(a, b)) out.push({ field: f as string, old: a as unknown, new: b as unknown });
  }
  return out;
}

export function summarizeDiff(diff: FieldDiff[]): string {
  if (!diff.length) return "no change";
  return diff.slice(0, 4).map((d) => {
    const ov = fmt(d.old);
    const nv = fmt(d.new);
    return `${d.field}: ${ov} → ${nv}`;
  }).join("; ") + (diff.length > 4 ? `; +${diff.length - 4} more` : "");
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (Array.isArray(v)) return v.length ? `[${v.slice(0, 3).join(",")}${v.length > 3 ? "…" : ""}]` : "[]";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}
