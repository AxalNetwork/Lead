// Task #3: Expand persona kinds taxonomy.
//
// Single source of truth for the persona-kind taxonomy. Both the form
// (consumed via GET /api/personas/taxonomy) and the matcher dispatcher
// read from this module. No taxonomy duplication in HTML or in plugin
// code — plugins reference KINDS[kind] to discover their group, label,
// allowed criteria sections, and required hint fields.

export type CriteriaSection =
  | "sizing"
  | "geography"
  | "industry"
  | "tech_stack"
  | "signals"
  | "buyer_profile"
  | "tuning";

export type HintField =
  | "subtype"
  | "aum_band"
  | "stage_focus"
  | "founded_count"
  | "prior_exits"
  | "domain_expertise";

export type PersonaKind =
  // Sales
  | "account_company" | "buyer_person"
  // Capital
  | "investor_firm" | "investor_person" | "angel_individual" | "limited_partner" | "venture_partner"
  // People
  | "founder" | "co_founder_match" | "executive_hire" | "engineering_hire" | "fractional_executive"
  // Partnerships
  | "channel_partner" | "integration_partner" | "design_partner" | "beta_tester"
  // Influence
  | "journalist_analyst" | "thought_leader" | "academic_researcher"
  // Public Sector
  | "government_grant_officer" | "regulator" | "policy_advisor"
  // Operational
  | "service_provider" | "acquirer" | "competitor";

export type PersonaKindGroup =
  | "Sales" | "Capital" | "People" | "Partnerships" | "Influence" | "Public Sector" | "Operational";

export interface KindDef {
  kind: PersonaKind;
  group: PersonaKindGroup;
  label: string;
  // Which criteria sections the form should render. Server-side
  // validation rejects criteria writes outside this set.
  sections: CriteriaSection[];
  // Required-criteria hint fields surfaced per kind.
  hints: HintField[];
  // Underlying entity kind in u_entities. Used by the generic
  // dispatcher to build the candidate query.
  targets: "person" | "fund" | "company";
  // Entity roles this kind matches against (entity_roles.role IN ...).
  // Empty array ⇒ no role filter (kind is generic over the entity kind).
  roles: string[];
}

// Hint-field metadata for the form (label, type, options).
export const HINTS: Record<HintField, { label: string; type: "text" | "number" | "select"; options?: string[]; placeholder?: string }> = {
  subtype: { label: "Subtype", type: "select", options: ["lawyer", "banker", "operator", "politician", "scout", "advisor", "board_member"] },
  aum_band: { label: "AUM band", type: "select", options: ["<$50M", "$50M-$250M", "$250M-$1B", "$1B-$5B", ">$5B"] },
  stage_focus: { label: "Stage focus", type: "text", placeholder: "pre_seed, seed, series_a" },
  founded_count: { label: "Companies founded (min)", type: "number" },
  prior_exits: { label: "Prior exits (min)", type: "number" },
  domain_expertise: { label: "Domain expertise", type: "text", placeholder: "fintech, dev_tools" },
};

const COMMON: CriteriaSection[] = ["geography", "industry", "signals", "tuning"];
const PERSON_BASE: CriteriaSection[] = [...COMMON, "buyer_profile"];
const COMPANY_BASE: CriteriaSection[] = ["sizing", ...COMMON, "tech_stack"];

export const KINDS_LIST: KindDef[] = [
  // ---- Sales
  { kind: "account_company", group: "Sales", label: "Account (company)",        sections: COMPANY_BASE,            hints: [],                targets: "company", roles: [] },
  { kind: "buyer_person",    group: "Sales", label: "Buyer (person)",            sections: PERSON_BASE,             hints: [],                targets: "person",  roles: ["buyer", "decision_maker", "champion"] },
  // ---- Capital
  { kind: "investor_firm",      group: "Capital", label: "Investor firm",         sections: ["sizing","geography","industry","signals","tuning"], hints: ["aum_band","stage_focus"],          targets: "fund",   roles: ["investor_firm"] },
  { kind: "investor_person",    group: "Capital", label: "Investor (person)",     sections: ["geography","industry","signals","buyer_profile","tuning"], hints: ["stage_focus"],                   targets: "person", roles: ["investor","vc","gp","partner_at_firm"] },
  { kind: "angel_individual",   group: "Capital", label: "Angel investor",        sections: ["geography","industry","signals","tuning"],                hints: ["domain_expertise"],              targets: "person", roles: ["angel","investor"] },
  { kind: "limited_partner",    group: "Capital", label: "Limited partner",       sections: ["geography","signals","tuning"],                            hints: ["aum_band"],                      targets: "person", roles: ["limited_partner","lp"] },
  { kind: "venture_partner",    group: "Capital", label: "Venture partner",       sections: ["geography","industry","signals","buyer_profile","tuning"], hints: ["subtype","domain_expertise"],    targets: "person", roles: ["venture_partner","advisor","scout"] },
  // ---- People
  { kind: "founder",            group: "People", label: "Founder",                sections: ["geography","industry","signals","tuning"],                hints: ["founded_count","prior_exits","domain_expertise"], targets: "person", roles: ["founder","ceo"] },
  { kind: "co_founder_match",   group: "People", label: "Co-founder match",       sections: ["geography","industry","tuning"],                          hints: ["domain_expertise","prior_exits"], targets: "person", roles: ["founder","engineer","designer"] },
  { kind: "executive_hire",     group: "People", label: "Executive hire",          sections: PERSON_BASE,                                                hints: ["domain_expertise"],              targets: "person", roles: ["executive","vp","c_suite"] },
  { kind: "engineering_hire",   group: "People", label: "Engineering hire",        sections: ["geography","tech_stack","signals","buyer_profile","tuning"], hints: ["domain_expertise"],           targets: "person", roles: ["engineer","ic"] },
  { kind: "fractional_executive", group: "People", label: "Fractional executive", sections: PERSON_BASE,                                                hints: ["domain_expertise","prior_exits"], targets: "person", roles: ["fractional","advisor","executive"] },
  // ---- Partnerships
  { kind: "channel_partner",     group: "Partnerships", label: "Channel partner",     sections: COMPANY_BASE,                                  hints: [], targets: "company", roles: ["partner","reseller"] },
  { kind: "integration_partner", group: "Partnerships", label: "Integration partner", sections: ["sizing","industry","tech_stack","signals","tuning"], hints: [], targets: "company", roles: ["partner","integration"] },
  { kind: "design_partner",      group: "Partnerships", label: "Design partner",      sections: COMPANY_BASE,                                  hints: [], targets: "company", roles: ["customer","prospect"] },
  { kind: "beta_tester",         group: "Partnerships", label: "Beta tester",         sections: ["geography","industry","tech_stack","signals","tuning"], hints: [], targets: "company", roles: ["customer","prospect","beta"] },
  // ---- Influence (no tech_stack — content/coverage focused)
  { kind: "journalist_analyst",  group: "Influence", label: "Journalist / analyst", sections: ["geography","industry","signals","tuning"], hints: ["domain_expertise"], targets: "person", roles: ["journalist","analyst","press"] },
  { kind: "thought_leader",      group: "Influence", label: "Thought leader",       sections: ["geography","industry","signals","tuning"], hints: ["domain_expertise"], targets: "person", roles: ["influencer","thought_leader","speaker"] },
  { kind: "academic_researcher", group: "Influence", label: "Academic researcher",  sections: ["geography","industry","tuning"],          hints: ["domain_expertise"], targets: "person", roles: ["researcher","academic","professor"] },
  // ---- Public Sector
  { kind: "government_grant_officer", group: "Public Sector", label: "Government grant officer", sections: ["geography","industry","tuning"], hints: ["domain_expertise"], targets: "person", roles: ["government","grant_officer","program_officer"] },
  { kind: "regulator",                group: "Public Sector", label: "Regulator",                sections: ["geography","industry","tuning"], hints: ["domain_expertise"], targets: "person", roles: ["regulator","agency_official"] },
  { kind: "policy_advisor",           group: "Public Sector", label: "Policy advisor",           sections: ["geography","industry","tuning"], hints: ["domain_expertise"], targets: "person", roles: ["policy_advisor","staffer","aide"] },
  // ---- Operational
  { kind: "service_provider", group: "Operational", label: "Service provider", sections: ["sizing","geography","industry","signals","tuning"], hints: ["domain_expertise"], targets: "company", roles: ["vendor","service_provider","agency"] },
  { kind: "acquirer",         group: "Operational", label: "Acquirer",         sections: ["sizing","geography","industry","signals","tuning"], hints: ["aum_band"],         targets: "company", roles: ["acquirer","strategic"] },
  { kind: "competitor",       group: "Operational", label: "Competitor",       sections: ["sizing","geography","industry","tech_stack","tuning"], hints: [],                targets: "company", roles: ["competitor"] },
];

export const KINDS: Record<PersonaKind, KindDef> = Object.fromEntries(
  KINDS_LIST.map((k) => [k.kind, k]),
) as Record<PersonaKind, KindDef>;

export const ALL_KIND_KEYS: PersonaKind[] = KINDS_LIST.map((k) => k.kind);

// Legacy values from before Task #3 — map to the closest new kind so
// existing personas keep working without a backfill migration.
export const LEGACY_KIND_MAP: Record<string, PersonaKind> = {
  account: "account_company",
  buyer: "buyer_person",
};

export function resolveKind(raw: string | null | undefined): PersonaKind | null {
  if (!raw) return null;
  if (KINDS[raw as PersonaKind]) return raw as PersonaKind;
  if (LEGACY_KIND_MAP[raw]) return LEGACY_KIND_MAP[raw];
  return null;
}

export function isValidKind(raw: string | null | undefined): boolean {
  return resolveKind(raw) !== null;
}

// Grouped view for the form's grouped <select>.
export function kindsGrouped(): Array<{ group: PersonaKindGroup; items: Array<{ kind: PersonaKind; label: string }> }> {
  const groups: PersonaKindGroup[] = ["Sales","Capital","People","Partnerships","Influence","Public Sector","Operational"];
  return groups.map((g) => ({
    group: g,
    items: KINDS_LIST.filter((k) => k.group === g).map((k) => ({ kind: k.kind, label: k.label })),
  }));
}

// Form-state validation. Rejects unknown sections — server enforces
// the per-kind allowlist even if the form skipped hiding fields.
export function allowedSections(kind: PersonaKind): Set<CriteriaSection> {
  return new Set(KINDS[kind].sections);
}
