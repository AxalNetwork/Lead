// Task #1: workflow registry.
//
// `getWorkflowForType(profile_type_id)` is the single dispatch point. It
// returns the dedicated module for the type when one is registered and
// the generic `_default` workflow otherwise. The URL crawler calls
// `getWorkflowForType` immediately after the page classifier (and the
// e_types `testPage` match) identifies the profile type.
//
// To add a new typed workflow:
//   1. Create `<profile_type_id>.ts` exporting a `ProfileWorkflow`.
//   2. Add the import + map entry below.
// Unknown / unimplemented types fall through to `_default` without code
// changes elsewhere.

import { defaultWorkflow } from "./_default";
import { investorVcWorkflow }            from "./investor_vc";
import { investorPeWorkflow }            from "./investor_pe";
import { investorAngelWorkflow }         from "./investor_angel";
import { investorCorporateVcWorkflow }   from "./investor_corporate_vc";
import { acceleratorWorkflow }           from "./accelerator";
import { fundOfFundsWorkflow }           from "./fund_of_funds";
import { familyOfficeWorkflow }          from "./family_office";
import { investorPersonWorkflow }        from "./investor_person";
import { lawyerSecuritiesWorkflow }      from "./lawyer_securities";
import { bankerInvestmentWorkflow }      from "./banker_investment";
import {
  founderWorkflow, coFounderWorkflow, foundingEngineerWorkflow, repeatFounderWorkflow,
} from "./founder";
import { politicianFederalWorkflow }     from "./politician_federal";
import { regulatorSecWorkflow }          from "./regulator_sec";
import { academicResearcherWorkflow }    from "./academic_researcher";
import { journalistBusinessWorkflow }    from "./journalist_business";

import type { ProfileWorkflow } from "./_types";

const WORKFLOWS: Record<string, ProfileWorkflow> = {
  investor_vc:           investorVcWorkflow,
  investor_pe:           investorPeWorkflow,
  investor_angel:        investorAngelWorkflow,
  investor_corporate_vc: investorCorporateVcWorkflow,
  accelerator:           acceleratorWorkflow,
  fund_of_funds:         fundOfFundsWorkflow,
  family_office:         familyOfficeWorkflow,
  investor_person:       investorPersonWorkflow,
  lawyer_securities:     lawyerSecuritiesWorkflow,
  banker_investment:     bankerInvestmentWorkflow,
  founder:               founderWorkflow,
  co_founder:            coFounderWorkflow,
  founding_engineer:     foundingEngineerWorkflow,
  repeat_founder:        repeatFounderWorkflow,
  politician_federal:    politicianFederalWorkflow,
  regulator_sec:         regulatorSecWorkflow,
  academic_researcher:   academicResearcherWorkflow,
  journalist_business:   journalistBusinessWorkflow,
};

/**
 * Returns the typed workflow for `profile_type_id`, or the generic
 * `_default` fallback when nothing is registered. Never returns null
 * so callers can dispatch without a guard.
 */
export function getWorkflowForType(profile_type_id: string | null | undefined): ProfileWorkflow {
  if (!profile_type_id) return defaultWorkflow;
  return WORKFLOWS[profile_type_id] ?? defaultWorkflow;
}

/**
 * Operator-console aid (Task #2): list every registered workflow with
 * its declared cost-per-run. The default workflow is included so the
 * fallback path shows up in the per-type spend roll-up.
 */
export function listWorkflows(): { profile_type_id: string; workflow_id: string; estimated_cost_per_run: ProfileWorkflow["estimated_cost_per_run"] }[] {
  const rows = Object.entries(WORKFLOWS).map(([typeId, w]) => ({
    profile_type_id: typeId,
    workflow_id: w.id,
    estimated_cost_per_run: w.estimated_cost_per_run,
  }));
  rows.push({
    profile_type_id: defaultWorkflow.profile_type_id,
    workflow_id: defaultWorkflow.id,
    estimated_cost_per_run: defaultWorkflow.estimated_cost_per_run,
  });
  return rows;
}

/** True when a dedicated (non-fallback) workflow is registered for the type. */
export function hasDedicatedWorkflow(profile_type_id: string | null | undefined): boolean {
  return !!profile_type_id && profile_type_id in WORKFLOWS;
}

export { defaultWorkflow };
