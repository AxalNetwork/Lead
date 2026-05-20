// Task #6: Corporate diligence checks.
//
// Reuses surfaces from prior tasks where present and degrades to
// needs_human (per the Task #14 honest-degradation pattern) when the
// underlying source table or fact isn't populated.

import type { CheckDefinition } from "../types";
import { safeQuery, needsHuman, passResult, failResult, cautionResult, readCurrentFact } from "../_util";

export const CORPORATE_CHECKS: CheckDefinition[] = [
  {
    key: "corporate.delaware_confirmed",
    section: "corporate",
    title: "Delaware incorporation confirmed",
    severity: "high",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "company.state_of_incorp");
      if (!f) return needsHuman(this.title, "no_state_of_incorp_fact", "high");
      const state = (f.value_text ?? "").trim().toUpperCase();
      if (state === "DE" || state === "DELAWARE") {
        return {
          ...passResult(this.title, "Incorporated in Delaware.", f.evidence_url ? [f.evidence_url] : []),
          derived_facts: [{ predicate: "diligence.corporate.delaware_confirmed", value_text: "true", confidence: 0.95 }],
        };
      }
      return cautionResult(this.title, `State of incorporation is \`${state}\` — not Delaware.`, "medium", f.evidence_url ? [f.evidence_url] : []);
    },
  },
  {
    key: "corporate.cap_table_sanity",
    section: "corporate",
    title: "Cap-table sanity (sum-of-shares ≈ totals)",
    severity: "high",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT SUM(shares_owned) AS sum_shares, MAX(total_shares_outstanding) AS total
             FROM cap_table_rows WHERE company_entity_id = ?`,
        ).bind(target_entity_id).first<{ sum_shares: number | null; total: number | null }>(),
        "cap_table_rows_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "high");
      const sum = q.value?.sum_shares ?? 0;
      const total = q.value?.total ?? 0;
      if (!sum || !total) return needsHuman(this.title, "no_cap_table_rows", "high");
      const drift = Math.abs(sum - total) / total;
      if (drift < 0.01) return passResult(this.title, `Sum-of-shares matches reported total within 1% (drift ${(drift * 100).toFixed(2)}%).`);
      return failResult(this.title, `Sum-of-shares drifts ${(drift * 100).toFixed(2)}% from reported total.`, "high");
    },
  },
  {
    key: "corporate.ucc_liens",
    section: "corporate",
    title: "UCC liens — no senior secured filings",
    severity: "high",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "company.ucc_lien_count");
      if (!f) return needsHuman(this.title, "no_ucc_data", "medium");
      const n = f.value_number ?? 0;
      if (n === 0) return passResult(this.title, "No active UCC-1 filings on record.");
      if (n <= 2) return cautionResult(this.title, `${n} active UCC-1 filing(s) on record — review priority/seniority.`, "medium", f.evidence_url ? [f.evidence_url] : []);
      return failResult(this.title, `${n} active UCC-1 filings — significant senior-secured exposure.`, "high", f.evidence_url ? [f.evidence_url] : []);
    },
  },
  {
    key: "corporate.litigation_company",
    section: "corporate",
    title: "Company-level litigation",
    severity: "high",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT COUNT(*) AS n FROM dd_findings
            WHERE entity_id = ? AND finding_type = 'litigation' AND status NOT IN ('false_positive','resolved')`,
        ).bind(target_entity_id).first<{ n: number }>(),
        "dd_findings_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "high");
      const n = q.value?.n ?? 0;
      if (n === 0) return passResult(this.title, "No active litigation findings.");
      if (n <= 1) return cautionResult(this.title, `${n} active litigation finding — review.`, "medium");
      return failResult(this.title, `${n} active litigation findings.`, "high");
    },
  },
  {
    key: "corporate.good_standing",
    section: "corporate",
    title: "Company good standing",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "company.good_standing");
      if (!f) return needsHuman(this.title, "no_good_standing_fact", "medium");
      const ok = (f.value_text ?? "").toLowerCase() === "good";
      return ok
        ? passResult(this.title, "Listed as in good standing.", f.evidence_url ? [f.evidence_url] : [])
        : failResult(this.title, `Good-standing status: \`${f.value_text}\`.`, "high", f.evidence_url ? [f.evidence_url] : []);
    },
  },
];
