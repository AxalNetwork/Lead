// Task #6: Regulatory-section checks. Routed by sector.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact, naResult, safeQuery } from "../_util";

async function getSector(env: import("../../../types").Env, entityId: string): Promise<string | null> {
  const f = await readCurrentFact(env, entityId, "company.primary_sector");
  return (f?.value_text ?? null);
}

function sectorMatches(sector: string | null, needles: string[]): boolean {
  if (!sector) return false;
  const s = sector.toLowerCase();
  return needles.some((n) => s.includes(n));
}

function regulatoryCheck(key: string, title: string, needles: string[], factPredicate: string): CheckDefinition {
  return {
    key,
    section: "regulatory",
    title,
    severity: "high",
    async run({ env, target_entity_id }) {
      const sector = await getSector(env, target_entity_id);
      if (!sectorMatches(sector, needles)) return naResult(title, `Sector ${sector ?? "unknown"} does not require this control.`);
      const f = await readCurrentFact(env, target_entity_id, factPredicate);
      if (!f) return needsHuman(title, `no_${factPredicate.replace(/\./g, "_")}_fact`, "high");
      const ok = (f.value_text ?? "").toLowerCase() === "true" || (f.value_number ?? 0) === 1;
      return ok
        ? passResult(title, "Control attested.", f.evidence_url ? [f.evidence_url] : [])
        : failResult(title, "Required control not attested.", "high", f.evidence_url ? [f.evidence_url] : []);
    },
  };
}

export const REGULATORY_CHECKS: CheckDefinition[] = [
  regulatoryCheck("regulatory.hipaa", "HIPAA compliance attested", ["health", "medic", "clinic", "hospital", "pharma"], "regulatory.hipaa_attested"),
  regulatoryCheck("regulatory.soc2", "SOC 2 Type II report on file", ["saas", "software", "data", "cloud", "infra"], "regulatory.soc2_attested"),
  regulatoryCheck("regulatory.ferpa", "FERPA compliance attested", ["edtech", "education", "school", "k12", "university"], "regulatory.ferpa_attested"),
  regulatoryCheck("regulatory.sr_11_7", "SR 11-7 model governance", ["bank", "fintech", "lending", "insur"], "regulatory.sr_11_7_attested"),
  regulatoryCheck("regulatory.itar", "ITAR / export controls", ["defense", "aerospace", "weapons", "dual-use"], "regulatory.itar_attested"),
  {
    key: "regulatory.privacy_policy",
    section: "regulatory",
    title: "Privacy policy published",
    severity: "low",
    async run({ env, target_entity_id }) {
      // Use safeQuery directly (NOT readCurrentFact) so a missing facts table
      // routes to needs_human rather than caution per Task #14 honest-degradation.
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT value_text, evidence_url FROM facts
            WHERE entity_id = ? AND predicate = 'company.privacy_policy_url' AND is_current = 1
            LIMIT 1`,
        ).bind(target_entity_id).first<{ value_text: string | null; evidence_url: string | null }>(),
        "facts_table_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "low");
      const row = q.value;
      if (!row || !row.value_text) return cautionResult(this.title, "No privacy policy URL on record.", "low");
      return passResult(this.title, `Privacy policy published.`, [row.value_text]);
    },
  },
];
