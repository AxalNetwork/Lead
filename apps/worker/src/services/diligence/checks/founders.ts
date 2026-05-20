// Task #6: Founder diligence checks. Reuse Task #14 verification surface
// (verification_findings table) wherever populated.

import type { CheckDefinition } from "../types";
import { safeQuery, needsHuman, passResult, failResult, cautionResult } from "../_util";

interface VFRow { status: string; claim_summary: string | null; evidence_url: string | null }

async function getFoundersOf(env: import("../../../types").Env, companyEntityId: string): Promise<string[]> {
  // founders mirrored as facts (founder.company_founded) or via career role 'founder'
  const out = new Set<string>();
  try {
    const r = await env.DB.prepare(
      `SELECT entity_id FROM facts
        WHERE predicate = 'founder.company_founded' AND value_entity_id = ? AND is_current = 1`,
    ).bind(companyEntityId).all<{ entity_id: string }>();
    for (const row of r.results ?? []) out.add(row.entity_id);
  } catch { /* table may differ */ }
  try {
    const r = await env.DB.prepare(
      `SELECT entity_id FROM career_history
        WHERE organization_entity_id = ? AND (role_title LIKE '%Founder%' OR role_title LIKE '%founder%')`,
    ).bind(companyEntityId).all<{ entity_id: string }>();
    for (const row of r.results ?? []) out.add(row.entity_id);
  } catch { /* ok */ }
  return [...out];
}

async function aggregateFounderVerification(env: import("../../../types").Env, companyEntityId: string, claimPredicate: string): Promise<{ confirmed: number; contradicted: number; unverifiable: number; evidence: string[] } | null> {
  const founders = await getFoundersOf(env, companyEntityId);
  if (!founders.length) return null;
  const out = { confirmed: 0, contradicted: 0, unverifiable: 0, evidence: [] as string[] };
  for (const f of founders) {
    const q = await safeQuery(
      () => env.DB.prepare(
        `SELECT status, claim_summary, evidence_url FROM verification_findings
          WHERE person_entity_id = ? AND claim_predicate = ? AND is_current = 1`,
      ).bind(f, claimPredicate).all<VFRow>(),
      "verification_findings_missing",
    );
    if (!q.ok) return null;
    for (const row of q.value.results ?? []) {
      if (row.status === "confirmed") out.confirmed++;
      else if (row.status === "contradicted") out.contradicted++;
      else out.unverifiable++;
      if (row.evidence_url) out.evidence.push(row.evidence_url);
    }
  }
  return out;
}

export const FOUNDER_CHECKS: CheckDefinition[] = [
  {
    key: "founders.education_verified",
    section: "founders",
    title: "Founder education verified",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const agg = await aggregateFounderVerification(env, target_entity_id, "person.education");
      if (!agg) return needsHuman(this.title, "no_founders_or_verifier_data", "medium");
      if (agg.contradicted > 0) return failResult(this.title, `${agg.contradicted} founder education claim(s) contradicted.`, "high", agg.evidence);
      if (agg.confirmed > 0) {
        return {
          ...passResult(this.title, `${agg.confirmed} founder education claim(s) confirmed.`, agg.evidence),
          derived_facts: [{ predicate: "diligence.founder.education_verified", value_text: "true", confidence: 0.9 }],
        };
      }
      return cautionResult(this.title, "Founder education unverifiable from public sources.", "medium");
    },
  },
  {
    key: "founders.employment_verified",
    section: "founders",
    title: "Founder employment history verified",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const agg = await aggregateFounderVerification(env, target_entity_id, "person.career_entry");
      if (!agg) return needsHuman(this.title, "no_founders_or_verifier_data", "medium");
      if (agg.contradicted > 0) return failResult(this.title, `${agg.contradicted} employment claim(s) contradicted.`, "high", agg.evidence);
      if (agg.confirmed > 0) return passResult(this.title, `${agg.confirmed} employment claim(s) confirmed.`, agg.evidence);
      return cautionResult(this.title, "Founder employment history unverifiable.", "medium");
    },
  },
  {
    key: "founders.prior_startup_outcome",
    section: "founders",
    title: "Founder prior startup outcomes",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const agg = await aggregateFounderVerification(env, target_entity_id, "person.prior_startup");
      if (!agg) return needsHuman(this.title, "no_prior_startup_data", "medium");
      if (agg.confirmed > 0) return passResult(this.title, `Prior startup outcomes recorded for ${agg.confirmed} founder claim(s).`, agg.evidence);
      return cautionResult(this.title, "Prior startup outcomes not yet recorded.", "low");
    },
  },
  {
    key: "founders.litigation_personal",
    section: "founders",
    title: "Founder personal litigation",
    severity: "high",
    async run({ env, target_entity_id }) {
      const founders = await getFoundersOf(env, target_entity_id);
      if (!founders.length) return needsHuman(this.title, "no_founders_resolved", "medium");
      let federal = 0;
      const evidence: string[] = [];
      for (const f of founders) {
        const fact = await safeQuery(
          () => env.DB.prepare(
            `SELECT value_number, evidence_url FROM facts
              WHERE entity_id = ? AND predicate = 'person.litigation.federal_hits' AND is_current = 1
              LIMIT 1`,
          ).bind(f).first<{ value_number: number | null; evidence_url: string | null }>(),
          "facts_missing",
        );
        if (!fact.ok) continue;
        if (fact.value?.value_number) federal += fact.value.value_number;
        if (fact.value?.evidence_url) evidence.push(fact.value.evidence_url);
      }
      if (federal === 0) return passResult(this.title, "No federal litigation hits across resolved founders.");
      if (federal <= 2) return cautionResult(this.title, `${federal} federal litigation hit(s) across founders — review for materiality.`, "medium", evidence);
      return failResult(this.title, `${federal} federal litigation hits across founders.`, "high", evidence);
    },
  },
  {
    key: "founders.sanctions_pep",
    section: "founders",
    title: "Founder sanctions / PEP screening",
    severity: "critical",
    async run({ env, target_entity_id }) {
      const founders = await getFoundersOf(env, target_entity_id);
      if (!founders.length) return needsHuman(this.title, "no_founders_resolved", "high");
      let hits = 0;
      const evidence: string[] = [];
      for (const f of founders) {
        const q = await safeQuery(
          () => env.DB.prepare(
            `SELECT COUNT(*) AS n FROM dd_findings
              WHERE entity_id = ? AND finding_type IN ('sanctions','pep') AND status NOT IN ('false_positive','resolved')`,
          ).bind(f).first<{ n: number }>(),
          "dd_findings_missing",
        );
        if (!q.ok) return needsHuman(this.title, q.reason, "high");
        hits += q.value?.n ?? 0;
      }
      if (hits === 0) {
        return {
          ...passResult(this.title, "No sanctions or PEP hits across resolved founders."),
          derived_facts: [{ predicate: "diligence.founder.sanctions_clean", value_text: "true", confidence: 0.85 }],
        };
      }
      return failResult(this.title, `${hits} sanctions/PEP hit(s) across founders.`, "critical", evidence);
    },
  },
];
