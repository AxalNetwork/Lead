// Task #6: IP-section checks. Reuses Task #109 patent surface where present.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact, safeQuery } from "../_util";

export const IP_CHECKS: CheckDefinition[] = [
  {
    key: "ip.patents_owned",
    section: "ip",
    title: "Patents owned (USPTO assignee match)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT COUNT(*) AS n FROM uspto_patents WHERE assignee_entity_id = ?`,
        ).bind(target_entity_id).first<{ n: number }>(),
        "uspto_patents_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "low");
      const n = q.value?.n ?? 0;
      if (n > 0) return passResult(this.title, `${n} patent(s) recorded under company assignee.`);
      return cautionResult(this.title, "No patents recorded — verify if relevant to sector.", "low");
    },
  },
  {
    key: "ip.trademark_status",
    section: "ip",
    title: "Trademark status (live registration)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "ip.trademark_status");
      if (!f) return needsHuman(this.title, "no_trademark_fact", "low");
      const s = (f.value_text ?? "").toLowerCase();
      if (s === "live" || s === "registered") return passResult(this.title, `Trademark status: ${s}.`, f.evidence_url ? [f.evidence_url] : []);
      if (s === "pending") return cautionResult(this.title, `Trademark pending.`, "low", f.evidence_url ? [f.evidence_url] : []);
      return failResult(this.title, `Trademark status: ${s}.`, "medium", f.evidence_url ? [f.evidence_url] : []);
    },
  },
  {
    key: "ip.oss_license_audit",
    section: "ip",
    title: "OSS license audit (no GPL contamination)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "ip.oss.gpl_dep_count");
      if (!f) return needsHuman(this.title, "no_oss_audit_fact", "medium");
      const n = f.value_number ?? 0;
      if (n === 0) return passResult(this.title, "No GPL-licensed dependencies detected in primary code paths.");
      if (n <= 1) return cautionResult(this.title, `${n} GPL-licensed dependency detected — verify scope.`, "medium");
      return failResult(this.title, `${n} GPL-licensed dependencies — license contamination risk.`, "high");
    },
  },
  {
    key: "ip.ip_assignment",
    section: "ip",
    title: "Founder IP assignment agreements signed",
    severity: "high",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "ip.assignment.founders_signed_pct");
      if (!f) return needsHuman(this.title, "no_ip_assignment_fact", "high");
      const pct = f.value_number ?? 0;
      if (pct >= 1.0) return passResult(this.title, "All founders have IP assignment agreements on file.");
      if (pct >= 0.5) return cautionResult(this.title, `${(pct * 100).toFixed(0)}% of founders have IP assignments.`, "medium");
      return failResult(this.title, `Only ${(pct * 100).toFixed(0)}% of founders have IP assignments.`, "high");
    },
  },
];
