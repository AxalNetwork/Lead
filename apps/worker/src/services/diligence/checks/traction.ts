// Task #6: Traction-section checks.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact, safeQuery } from "../_util";

export const TRACTION_CHECKS: CheckDefinition[] = [
  {
    key: "traction.logo_verifiability",
    section: "traction",
    title: "Customer logo verifiability",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
             FROM facts
            WHERE entity_id = ? AND predicate = 'company.customer_logo' AND is_current = 1`,
        ).bind(target_entity_id).first<{ total: number; verified: number }>(),
        "facts_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "medium");
      const total = q.value?.total ?? 0;
      const verified = q.value?.verified ?? 0;
      if (total === 0) return needsHuman(this.title, "no_customer_logos_recorded", "medium");
      const ratio = verified / total;
      if (ratio >= 0.7) return passResult(this.title, `${verified}/${total} logos third-party verifiable.`);
      if (ratio >= 0.3) return cautionResult(this.title, `${verified}/${total} logos verified — moderate confidence.`, "medium");
      return failResult(this.title, `${verified}/${total} logos verified.`, "high");
    },
  },
  {
    key: "traction.reference_customer_reachable",
    section: "traction",
    title: "Reference customer reachable",
    severity: "low",
    async run() {
      return needsHuman(this.title, "manual_call_required", "low");
    },
  },
  {
    key: "traction.revenue_consistency",
    section: "traction",
    title: "Revenue consistency (ARR vs MRR×12)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const arr = await readCurrentFact(env, target_entity_id, "commercial.arr_usd");
      const mrr = await readCurrentFact(env, target_entity_id, "commercial.mrr_usd");
      if (!arr || !mrr) return needsHuman(this.title, "no_arr_or_mrr", "medium");
      const a = arr.value_number ?? 0;
      const m = (mrr.value_number ?? 0) * 12;
      if (a === 0 || m === 0) return needsHuman(this.title, "zero_value", "medium");
      const drift = Math.abs(a - m) / Math.max(a, m);
      if (drift < 0.1) return passResult(this.title, `ARR aligns with MRR×12 within 10% (drift ${(drift * 100).toFixed(0)}%).`);
      return cautionResult(this.title, `ARR vs MRR×12 drift ${(drift * 100).toFixed(0)}%.`, "medium");
    },
  },
  {
    key: "traction.concentration_risk",
    section: "traction",
    title: "Customer concentration risk",
    severity: "high",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "commercial.top_customer_pct");
      if (!f) return needsHuman(this.title, "no_concentration_fact", "medium");
      const pct = f.value_number ?? 0;
      if (pct < 0.20) return passResult(this.title, `Top customer is ${(pct * 100).toFixed(0)}% of revenue.`);
      if (pct < 0.40) return cautionResult(this.title, `Top customer is ${(pct * 100).toFixed(0)}% of revenue.`, "medium");
      return failResult(this.title, `Top customer is ${(pct * 100).toFixed(0)}% of revenue.`, "high");
    },
  },
];
