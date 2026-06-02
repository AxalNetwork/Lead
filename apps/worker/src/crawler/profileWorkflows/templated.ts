// Task #1: Templated workflow factory.
//
// The e_types registry (migrations/340_profile_types_seed.sql) enumerates
// ~110 profile types. A dedicated module exists for the 18 "thick"
// types whose source plan or extraction shape diverges from the
// generic template (investor_vc, investor_person, founder family,
// politician_federal, regulator_sec, academic_researcher, etc.). For
// the remaining types — most of which are either firm-shaped or
// person-shaped variants on the same plan — we register a templated
// workflow here so every seeded type id resolves to a typed workflow
// rather than the _default fallback.
//
// Each templated workflow:
//   - Picks the FIRM or PERSON schema from `_commonSchemas`.
//   - Uses the public-source plan that matches its shape
//     (firm  : same-origin + Wikipedia + Crunchbase org + LinkedIn company).
//     (person: same-origin + LinkedIn person + Crunchbase person + Twitter).
//   - Stamps a `type_variant` predicate so the operator dashboard can
//     fan one entity into per-type records when the same page resolves
//     to multiple sibling types.
//
// To "thicken" a templated type later, drop a dedicated file in this
// folder and register it in registry.ts above the template registration
// — the dedicated module wins because the map preserves insertion order.

import { makeWorkflow, sameOrigin } from "./_shared";
import {
  FIRM_SCHEMA, type FirmExtract, mapFirm,
  PERSON_SCHEMA, type PersonExtract, mapPerson,
  wikipediaUrl, crunchbaseOrgUrl, linkedinCompanyUrl,
  linkedinPersonUrl, crunchbasePersonUrl, twitterUrl, secEdgarAdvUrl,
} from "./_commonSchemas";
import type { FactCandidate, ProfileWorkflow, WorkflowDef } from "./_types";

type Kind = "firm" | "person";

interface TemplateSpec {
  typeId: string;
  label: string;
  kind: Kind;
  /** Append SEC EDGAR ADV adviser-search to the plan (regulated capital). */
  includeSecAdv?: boolean;
}

/** Firm-shaped public sources: org pages, Wikipedia entity, Crunchbase, LinkedIn. */
function firmPlanFor(spec: TemplateSpec) {
  return (ctx: import("./_types").WorkflowContext) => [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/portfolio", "/news"]),
    wikipediaUrl(ctx),
    crunchbaseOrgUrl(ctx),
    linkedinCompanyUrl(ctx),
    ...(spec.includeSecAdv ? [secEdgarAdvUrl(ctx)] : []),
  ];
}

/** Person-shaped public sources: bio sibling + LinkedIn + Crunchbase + Twitter. */
function personPlan(ctx: import("./_types").WorkflowContext) {
  return [
    ...sameOrigin(ctx.candidateUrl, ["/about", "/team", "/people", "/bio"]),
    linkedinPersonUrl(ctx),
    crunchbasePersonUrl(ctx),
    twitterUrl(ctx),
  ];
}

function makeTemplatedDef(spec: TemplateSpec): WorkflowDef {
  if (spec.kind === "firm") {
    return {
      id: `${spec.typeId}.v1`,
      profile_type_id: spec.typeId,
      estimated_cost_per_run: { sources: spec.includeSecAdv ? 8 : 7, ai_neurons: 0.6 },
      plan: firmPlanFor(spec),
      extractionSchema: FIRM_SCHEMA as unknown as Record<string, unknown>,
      systemPrompt:
        `Extract facts about a ${spec.label} from one of its public pages or ` +
        "a Wikipedia entry. Use lowercase tags for sectors / geo_focus. AUM / " +
        "check size are in USD (convert M/B). GP / partner names are full " +
        "names. Reply strict JSON matching the schema; omit fields you cannot infer.",
      map: ({ aiJson, source }) => {
        const out: FactCandidate[] = mapFirm(aiJson as FirmExtract, source);
        const conf = Math.min(0.95, Math.max(0.3, Number((aiJson as { confidence?: number })?.confidence ?? 0.6)));
        // Stamp the variant so operator dashboards can route this entity
        // through the right per-type roll-up without re-classifying.
        out.push({ predicate: "firm.type_variant", valueText: spec.typeId, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
        return out;
      },
    };
  }
  // person
  return {
    id: `${spec.typeId}.v1`,
    profile_type_id: spec.typeId,
    harvestIdentities: true,
    estimated_cost_per_run: { sources: 5, ai_neurons: 0.5 },
    plan: personPlan,
    extractionSchema: PERSON_SCHEMA as unknown as Record<string, unknown>,
    systemPrompt:
      `Extract facts about a ${spec.label} from a bio, profile page, or ` +
      "LinkedIn / Crunchbase entry. focus_areas is a list of lowercase " +
      "topics they work on. Reply strict JSON matching the schema; omit " +
      "fields you cannot infer.",
    map: ({ aiJson, source }) => {
      const out: FactCandidate[] = mapPerson(aiJson as PersonExtract, source, "person");
      const conf = Math.min(0.95, Math.max(0.3, Number((aiJson as { confidence?: number })?.confidence ?? 0.6)));
      out.push({ predicate: "person.type_variant", valueText: spec.typeId, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      return out;
    },
  };
}

// ---- Full coverage roster ----------------------------------------------
//
// Every type id from migrations/340_profile_types_seed.sql that does NOT
// have a dedicated module appears here. New seed entries must be added
// to this list (or a dedicated module) — the smoke test in
// `test/profileWorkflows.test.mjs` enforces coverage.

const TEMPLATED_SPECS: TemplateSpec[] = [
  // Firms — capital / financial / advisory
  { typeId: "investor",                 label: "investor",                kind: "firm" },
  { typeId: "investor_micro_vc",        label: "micro VC firm",           kind: "firm", includeSecAdv: true },
  { typeId: "investor_family_office",   label: "family office (LP)",      kind: "firm", includeSecAdv: true },
  { typeId: "investor_endowment",       label: "endowment",               kind: "firm", includeSecAdv: true },
  { typeId: "investor_sovereign",       label: "sovereign wealth fund",   kind: "firm" },
  { typeId: "investor_pension",         label: "pension fund",            kind: "firm", includeSecAdv: true },
  { typeId: "incubator",                label: "startup incubator",       kind: "firm" },
  { typeId: "venture_studio",           label: "venture studio",          kind: "firm" },
  { typeId: "syndicate",                label: "investing syndicate",     kind: "firm" },
  { typeId: "secondary_buyer",          label: "secondaries buyer",       kind: "firm", includeSecAdv: true },
  { typeId: "hedge_fund",               label: "hedge fund",              kind: "firm", includeSecAdv: true },
  { typeId: "asset_manager",            label: "asset manager",           kind: "firm", includeSecAdv: true },
  { typeId: "investment_bank",          label: "investment bank",         kind: "firm" },
  { typeId: "commercial_bank",          label: "commercial bank",         kind: "firm" },
  { typeId: "private_bank",             label: "private bank",            kind: "firm" },
  { typeId: "broker_dealer",            label: "broker-dealer",           kind: "firm" },
  { typeId: "exchange_traditional",     label: "stock exchange",          kind: "firm" },
  { typeId: "exchange_crypto",          label: "crypto exchange",         kind: "firm" },
  { typeId: "custodian",                label: "custodian bank",          kind: "firm" },
  { typeId: "clearinghouse",            label: "clearinghouse",           kind: "firm" },
  { typeId: "payment_processor",        label: "payment processor",       kind: "firm" },
  { typeId: "insurance",                label: "insurance company",       kind: "firm" },
  { typeId: "reinsurer",                label: "reinsurer",               kind: "firm" },
  { typeId: "accounting_firm",          label: "accounting firm",         kind: "firm" },
  { typeId: "consulting_firm",          label: "consulting firm",         kind: "firm" },
  { typeId: "law_firm",                 label: "law firm",                kind: "firm" },
  { typeId: "marketing_agency",         label: "marketing agency",        kind: "firm" },
  { typeId: "pr_firm",                  label: "PR firm",                 kind: "firm" },
  { typeId: "design_agency",            label: "design agency",           kind: "firm" },
  { typeId: "dev_shop",                 label: "development agency",      kind: "firm" },
  { typeId: "executive_search_firm",    label: "executive search firm",   kind: "firm" },
  { typeId: "conference_organizer",     label: "conference organizer",    kind: "firm" },
  // Firms — companies (operating)
  { typeId: "portfolio_company",        label: "portfolio company",      kind: "firm" },
  { typeId: "public_company",           label: "public company",         kind: "firm" },
  { typeId: "enterprise",               label: "enterprise",             kind: "firm" },
  { typeId: "sme",                      label: "small or mid-size business", kind: "firm" },
  { typeId: "startup_pre_seed",         label: "pre-seed startup",       kind: "firm" },
  { typeId: "startup_seed",             label: "seed-stage startup",     kind: "firm" },
  { typeId: "startup_series_a",         label: "Series A startup",       kind: "firm" },
  { typeId: "startup_growth",           label: "growth-stage startup",   kind: "firm" },
  { typeId: "startup_late_stage",       label: "late-stage startup",     kind: "firm" },
  { typeId: "acquirer_strategic",       label: "strategic acquirer",     kind: "firm" },
  // Firms — public sector / civil society
  { typeId: "government_agency_federal", label: "federal government agency", kind: "firm" },
  { typeId: "government_agency_state",   label: "state government agency",   kind: "firm" },
  { typeId: "government_agency_local",   label: "local government agency",   kind: "firm" },
  { typeId: "multilateral_org",         label: "multilateral organization", kind: "firm" },
  { typeId: "ngo",                      label: "non-governmental organization", kind: "firm" },
  { typeId: "think_tank",               label: "think tank",             kind: "firm" },
  // Firms — target-customer profiles (sales-intent enrichment).
  { typeId: "target_customer_b2b",      label: "B2B target customer",    kind: "firm" },
  { typeId: "target_customer_b2c",      label: "B2C target customer",    kind: "firm" },

  // Persons — capital
  { typeId: "firm_person",              label: "person at a firm",        kind: "person" },
  { typeId: "gp_partner",               label: "general partner",         kind: "person" },
  { typeId: "principal",                label: "principal",               kind: "person" },
  { typeId: "associate",                label: "associate",               kind: "person" },
  { typeId: "scout",                    label: "venture scout",           kind: "person" },
  { typeId: "venture_partner",          label: "venture partner",         kind: "person" },
  { typeId: "operating_partner",        label: "operating partner",       kind: "person" },
  { typeId: "entrepreneur_in_residence", label: "entrepreneur in residence", kind: "person" },
  // Persons — legal
  { typeId: "advisor",                  label: "advisor",                 kind: "person" },
  { typeId: "board_member",             label: "board member",            kind: "person" },
  { typeId: "lawyer",                   label: "lawyer",                  kind: "person" },
  { typeId: "lawyer_corporate",         label: "corporate lawyer",        kind: "person" },
  { typeId: "lawyer_ip",                label: "IP lawyer",               kind: "person" },
  { typeId: "lawyer_employment",        label: "employment lawyer",       kind: "person" },
  { typeId: "lawyer_immigration",       label: "immigration lawyer",      kind: "person" },
  { typeId: "lawyer_tax",               label: "tax lawyer",              kind: "person" },
  { typeId: "patent_agent",             label: "patent agent",            kind: "person" },
  // Persons — financial
  { typeId: "banker_commercial",        label: "commercial banker",       kind: "person" },
  { typeId: "banker_private",           label: "private banker",          kind: "person" },
  { typeId: "banker_m_and_a",           label: "M&A banker",              kind: "person" },
  // Persons — operators / fractionals
  { typeId: "operator_growth",          label: "growth operator",         kind: "person" },
  { typeId: "operator_sales",           label: "sales operator",          kind: "person" },
  { typeId: "operator_marketing",       label: "marketing operator",      kind: "person" },
  { typeId: "operator_product",         label: "product operator",        kind: "person" },
  { typeId: "operator_engineering",     label: "engineering operator",    kind: "person" },
  { typeId: "fractional_cfo",           label: "fractional CFO",          kind: "person" },
  { typeId: "fractional_cto",           label: "fractional CTO",          kind: "person" },
  { typeId: "fractional_coo",           label: "fractional COO",          kind: "person" },
  { typeId: "fractional_cmo",           label: "fractional CMO",          kind: "person" },
  { typeId: "executive_recruiter",      label: "executive recruiter",     kind: "person" },
  // Persons — founders / operators (variants of founder)
  { typeId: "business_founder",         label: "business founder",        kind: "person" },
  { typeId: "founder_solo",             label: "solo founder",            kind: "person" },
  { typeId: "founding_designer",        label: "founding designer",       kind: "person" },
  { typeId: "founding_pm",              label: "founding product manager", kind: "person" },
  { typeId: "technical_founder",        label: "technical founder",       kind: "person" },
  { typeId: "serial_entrepreneur",      label: "serial entrepreneur",     kind: "person" },
  // Persons — public sector / policy
  { typeId: "politician_state",         label: "state politician",        kind: "person" },
  { typeId: "politician_local",         label: "local politician",        kind: "person" },
  { typeId: "policy_advisor",           label: "policy advisor",          kind: "person" },
  // Persons — academic / press / influence
  { typeId: "professor",                label: "professor",               kind: "person" },
  { typeId: "research_scientist",       label: "research scientist",      kind: "person" },
  { typeId: "lab_principal_investigator", label: "lab principal investigator", kind: "person" },
  { typeId: "postdoc",                  label: "postdoctoral researcher", kind: "person" },
  { typeId: "phd_student",              label: "PhD student",             kind: "person" },
  { typeId: "technology_transfer_officer", label: "technology transfer officer", kind: "person" },
  { typeId: "journalist_tech",          label: "tech journalist",         kind: "person" },
  { typeId: "journalist_crypto",        label: "crypto journalist",       kind: "person" },
  { typeId: "analyst_industry",         label: "industry analyst",        kind: "person" },
  { typeId: "newsletter_writer",        label: "newsletter writer",       kind: "person" },
  { typeId: "podcast_host",             label: "podcast host",            kind: "person" },
  { typeId: "thought_leader",           label: "thought leader",          kind: "person" },
  { typeId: "youtuber_business",        label: "business YouTuber",       kind: "person" },
];

/** Map of templated workflow id → ProfileWorkflow. Consumed by registry.ts. */
export const TEMPLATED_WORKFLOWS: Record<string, ProfileWorkflow> =
  Object.fromEntries(TEMPLATED_SPECS.map((s) => [s.typeId, makeWorkflow(makeTemplatedDef(s))]));

/** Exposed for tests + operator console — full list of types this file covers. */
export const TEMPLATED_TYPE_IDS: readonly string[] =
  TEMPLATED_SPECS.map((s) => s.typeId);
