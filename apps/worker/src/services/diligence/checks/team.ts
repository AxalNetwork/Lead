// Task #6: Team-section checks.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact, safeQuery } from "../_util";

export const TEAM_CHECKS: CheckDefinition[] = [
  {
    key: "team.retention",
    section: "team",
    title: "Employee retention (trailing-12m)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "team.retention_pct_12m");
      if (!f) return needsHuman(this.title, "no_retention_fact", "medium");
      const r = f.value_number ?? 0;
      if (r >= 0.85) return passResult(this.title, `${(r * 100).toFixed(0)}% retention.`);
      if (r >= 0.70) return cautionResult(this.title, `${(r * 100).toFixed(0)}% retention — below benchmark.`, "medium");
      return failResult(this.title, `${(r * 100).toFixed(0)}% retention — high attrition.`, "high");
    },
  },
  {
    key: "team.tenure_distribution",
    section: "team",
    title: "Tenure distribution (median ≥ 12 months)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "team.median_tenure_months");
      if (!f) return needsHuman(this.title, "no_tenure_fact", "low");
      const m = f.value_number ?? 0;
      if (m >= 12) return passResult(this.title, `Median tenure ${m} months.`);
      return cautionResult(this.title, `Median tenure ${m} months.`, "low");
    },
  },
  {
    key: "team.hiring_pace",
    section: "team",
    title: "Hiring pace consistent with stated plan",
    severity: "low",
    async run({ env, target_entity_id }) {
      const planned = await readCurrentFact(env, target_entity_id, "team.hiring_plan_12m");
      const actual = await readCurrentFact(env, target_entity_id, "team.net_hires_12m");
      if (!planned || !actual) return needsHuman(this.title, "no_hiring_data", "low");
      const p = planned.value_number ?? 0, a = actual.value_number ?? 0;
      if (p === 0) return needsHuman(this.title, "no_hiring_plan", "low");
      const ratio = a / p;
      if (ratio >= 0.7) return passResult(this.title, `${a} hires vs ${p} planned (${(ratio * 100).toFixed(0)}%).`);
      return cautionResult(this.title, `${a} hires vs ${p} planned (${(ratio * 100).toFixed(0)}%).`, "low");
    },
  },
  {
    key: "team.senior_departures",
    section: "team",
    title: "Senior departures (last 12 months)",
    severity: "high",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT COUNT(*) AS n FROM career_history ch
            WHERE ch.organization_entity_id = ?
              AND ch.role_title IS NOT NULL
              AND (LOWER(ch.role_title) LIKE '%vp%' OR LOWER(ch.role_title) LIKE '%chief%' OR LOWER(ch.role_title) LIKE '%head of%')
              AND ch.ended_at IS NOT NULL
              AND ch.ended_at >= date('now','-12 months')`,
        ).bind(target_entity_id).first<{ n: number }>(),
        "career_history_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "medium");
      const n = q.value?.n ?? 0;
      if (n === 0) return passResult(this.title, "No senior departures recorded in 12 months.");
      if (n <= 2) return cautionResult(this.title, `${n} senior departure(s) in 12 months.`, "medium");
      return failResult(this.title, `${n} senior departures in 12 months.`, "high");
    },
  },
];
