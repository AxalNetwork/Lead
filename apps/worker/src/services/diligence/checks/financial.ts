// Task #6: Financial-section checks.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact } from "../_util";

export const FINANCIAL_CHECKS: CheckDefinition[] = [
  {
    key: "financial.burn_runway",
    section: "financial",
    title: "Burn vs runway (≥ 12 months)",
    severity: "high",
    async run({ env, target_entity_id }) {
      const burn = await readCurrentFact(env, target_entity_id, "financial.net_burn_usd_month");
      const cash = await readCurrentFact(env, target_entity_id, "financial.cash_balance_usd");
      if (!burn || !cash) return needsHuman(this.title, "no_burn_or_cash_fact", "high");
      const b = burn.value_number ?? 0, c = cash.value_number ?? 0;
      if (b <= 0) return passResult(this.title, "Profitable / no net burn.");
      const months = c / b;
      if (months >= 18) return passResult(this.title, `${months.toFixed(0)} months runway.`);
      if (months >= 9) return cautionResult(this.title, `${months.toFixed(0)} months runway — plan for next raise.`, "medium");
      return failResult(this.title, `${months.toFixed(0)} months runway — immediate funding concern.`, "high");
    },
  },
  {
    key: "financial.unit_economics",
    section: "financial",
    title: "Unit economics (LTV : CAC ≥ 3)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const ltv = await readCurrentFact(env, target_entity_id, "commercial.ltv_usd");
      const cac = await readCurrentFact(env, target_entity_id, "commercial.cac_usd");
      if (!ltv || !cac) return needsHuman(this.title, "no_ltv_or_cac", "medium");
      const l = ltv.value_number ?? 0, c = cac.value_number ?? 0;
      if (c === 0) return needsHuman(this.title, "zero_cac", "medium");
      const ratio = l / c;
      if (ratio >= 3) return passResult(this.title, `LTV:CAC = ${ratio.toFixed(1)}.`);
      if (ratio >= 1.5) return cautionResult(this.title, `LTV:CAC = ${ratio.toFixed(1)}.`, "medium");
      return failResult(this.title, `LTV:CAC = ${ratio.toFixed(1)}.`, "high");
    },
  },
  {
    key: "financial.revenue_recognition",
    section: "financial",
    title: "Revenue recognition red flags",
    severity: "high",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "financial.revenue_recognition_flags");
      if (!f) return needsHuman(this.title, "no_revrec_fact", "medium");
      const flags = f.value_number ?? 0;
      if (flags === 0) return passResult(this.title, "No revenue-recognition red flags raised.");
      if (flags <= 1) return cautionResult(this.title, `${flags} red flag(s) raised — review.`, "medium");
      return failResult(this.title, `${flags} red flags raised.`, "high");
    },
  },
  {
    key: "financial.related_party",
    section: "financial",
    title: "Related-party transactions disclosed",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "financial.related_party_disclosures");
      if (!f) return needsHuman(this.title, "no_related_party_fact", "medium");
      const n = f.value_number ?? 0;
      if (n === 0) return passResult(this.title, "No related-party transactions disclosed.");
      return cautionResult(this.title, `${n} related-party transaction(s) disclosed — review terms.`, "medium");
    },
  },
];
