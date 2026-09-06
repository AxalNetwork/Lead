// Task #3: Expand persona kinds taxonomy.
//
// Single source of truth for the persona-kind taxonomy. Both the form
// (consumed via GET /api/personas/taxonomy) and the matcher dispatcher
// read from this module. No taxonomy duplication in HTML or in plugin
// code — plugins reference KINDS[kind] to discover their group, label,
// allowed criteria sections, and required hint fields.
// Hint-field metadata for the form (label, type, options).
export const HINTS = {
    subtype: { label: "Subtype", type: "select", options: ["lawyer", "banker", "operator", "politician", "scout", "advisor", "board_member"] },
    aum_band: { label: "AUM band", type: "select", options: ["<$50M", "$50M-$250M", "$250M-$1B", "$1B-$5B", ">$5B"] },
    stage_focus: { label: "Stage focus", type: "text", placeholder: "pre_seed, seed, series_a" },
    founded_count: { label: "Companies founded (min)", type: "number" },
    prior_exits: { label: "Prior exits (min)", type: "number" },
    domain_expertise: { label: "Domain expertise", type: "text", placeholder: "fintech, dev_tools" },
};
const COMMON = ["geography", "industry", "signals", "tuning"];
const PERSON_BASE = [...COMMON, "buyer_profile"];
const COMPANY_BASE = ["sizing", ...COMMON, "tech_stack"];
export const KINDS_LIST = [
    // ---- Sales
    { kind: "account_company", group: "Sales", label: "Account (company)", sections: COMPANY_BASE, hints: [], targets: "company", roles: [] },
    { kind: "buyer_person", group: "Sales", label: "Buyer (person)", sections: PERSON_BASE, hints: [], targets: "person", roles: ["buyer", "decision_maker", "champion"] },
    // ---- Capital
    { kind: "investor_firm", group: "Capital", label: "Investor firm", sections: ["sizing", "geography", "industry", "signals", "tuning"], hints: ["aum_band", "stage_focus"], targets: "fund", roles: ["investor_firm"] },
    { kind: "investor_person", group: "Capital", label: "Investor (person)", sections: ["geography", "industry", "signals", "buyer_profile", "tuning"], hints: ["stage_focus"], targets: "person", roles: ["investor", "vc", "gp", "partner_at_firm"] },
    { kind: "angel_individual", group: "Capital", label: "Angel investor", sections: ["geography", "industry", "signals", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["angel", "investor"] },
    { kind: "limited_partner", group: "Capital", label: "Limited partner", sections: ["geography", "signals", "tuning"], hints: ["aum_band"], targets: "person", roles: ["limited_partner", "lp"] },
    { kind: "venture_partner", group: "Capital", label: "Venture partner", sections: ["geography", "industry", "signals", "buyer_profile", "tuning"], hints: ["subtype", "domain_expertise"], targets: "person", roles: ["venture_partner", "advisor", "scout"] },
    // ---- People
    { kind: "founder", group: "People", label: "Founder", sections: ["geography", "industry", "signals", "tuning"], hints: ["founded_count", "prior_exits", "domain_expertise"], targets: "person", roles: ["founder", "ceo"] },
    { kind: "co_founder_match", group: "People", label: "Co-founder match", sections: ["geography", "industry", "tuning"], hints: ["domain_expertise", "prior_exits"], targets: "person", roles: ["founder", "engineer", "designer"] },
    { kind: "executive_hire", group: "People", label: "Executive hire", sections: PERSON_BASE, hints: ["domain_expertise"], targets: "person", roles: ["executive", "vp", "c_suite"] },
    { kind: "engineering_hire", group: "People", label: "Engineering hire", sections: ["geography", "tech_stack", "signals", "buyer_profile", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["engineer", "ic"] },
    { kind: "fractional_executive", group: "People", label: "Fractional executive", sections: PERSON_BASE, hints: ["domain_expertise", "prior_exits"], targets: "person", roles: ["fractional", "advisor", "executive"] },
    // ---- Partnerships
    { kind: "channel_partner", group: "Partnerships", label: "Channel partner", sections: COMPANY_BASE, hints: [], targets: "company", roles: ["partner", "reseller"] },
    { kind: "integration_partner", group: "Partnerships", label: "Integration partner", sections: ["sizing", "industry", "tech_stack", "signals", "tuning"], hints: [], targets: "company", roles: ["partner", "integration"] },
    { kind: "design_partner", group: "Partnerships", label: "Design partner", sections: COMPANY_BASE, hints: [], targets: "company", roles: ["customer", "prospect"] },
    { kind: "beta_tester", group: "Partnerships", label: "Beta tester", sections: ["geography", "industry", "tech_stack", "signals", "tuning"], hints: [], targets: "company", roles: ["customer", "prospect", "beta"] },
    // ---- Influence (no tech_stack — content/coverage focused)
    { kind: "journalist_analyst", group: "Influence", label: "Journalist / analyst", sections: ["geography", "industry", "signals", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["journalist", "analyst", "press"] },
    { kind: "thought_leader", group: "Influence", label: "Thought leader", sections: ["geography", "industry", "signals", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["influencer", "thought_leader", "speaker"] },
    { kind: "academic_researcher", group: "Influence", label: "Academic researcher", sections: ["geography", "industry", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["researcher", "academic", "professor"] },
    // ---- Public Sector
    { kind: "government_grant_officer", group: "Public Sector", label: "Government grant officer", sections: ["geography", "industry", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["government", "grant_officer", "program_officer"] },
    { kind: "regulator", group: "Public Sector", label: "Regulator", sections: ["geography", "industry", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["regulator", "agency_official"] },
    { kind: "policy_advisor", group: "Public Sector", label: "Policy advisor", sections: ["geography", "industry", "tuning"], hints: ["domain_expertise"], targets: "person", roles: ["policy_advisor", "staffer", "aide"] },
    // ---- Operational
    { kind: "service_provider", group: "Operational", label: "Service provider", sections: ["sizing", "geography", "industry", "signals", "tuning"], hints: ["domain_expertise"], targets: "company", roles: ["vendor", "service_provider", "agency"] },
    { kind: "acquirer", group: "Operational", label: "Acquirer", sections: ["sizing", "geography", "industry", "signals", "tuning"], hints: ["aum_band"], targets: "company", roles: ["acquirer", "strategic"] },
    { kind: "competitor", group: "Operational", label: "Competitor", sections: ["sizing", "geography", "industry", "tech_stack", "tuning"], hints: [], targets: "company", roles: ["competitor"] },
];
export const KINDS = Object.fromEntries(KINDS_LIST.map((k) => [k.kind, k]));
export const ALL_KIND_KEYS = KINDS_LIST.map((k) => k.kind);
// Legacy values from before Task #3 — map to the closest new kind so
// existing personas keep working without a backfill migration.
export const LEGACY_KIND_MAP = {
    account: "account_company",
    buyer: "buyer_person",
};
export function resolveKind(raw) {
    if (!raw)
        return null;
    if (KINDS[raw])
        return raw;
    if (LEGACY_KIND_MAP[raw])
        return LEGACY_KIND_MAP[raw];
    return null;
}
export function isValidKind(raw) {
    return resolveKind(raw) !== null;
}
// Grouped view for the form's grouped <select>.
export function kindsGrouped() {
    const groups = ["Sales", "Capital", "People", "Partnerships", "Influence", "Public Sector", "Operational"];
    return groups.map((g) => ({
        group: g,
        items: KINDS_LIST.filter((k) => k.group === g).map((k) => ({ kind: k.kind, label: k.label })),
    }));
}
// Form-state validation. Rejects unknown sections — server enforces
// the per-kind allowlist even if the form skipped hiding fields.
export function allowedSections(kind) {
    return new Set(KINDS[kind].sections);
}
