// Task #3: persona-kind plugin registry + dispatcher entrypoint.
//
// The PersonaMatchingService reads the persona's kind, calls
// getPluginFor(kind), and delegates to defaultEntityFilter / scoreEntity.
// Kinds without a bespoke plugin file fall back to the generic plugin
// driven by the taxonomy's `roles` array (see _generic.ts).
import { ALL_KIND_KEYS, KINDS, resolveKind } from "./taxonomy";
import { investorPersonPlugin } from "./investor_person";
import { investorFirmPlugin } from "./investor_firm";
import { venturePartnerPlugin } from "./venture_partner";
import { founderPlugin } from "./founder";
import { accountCompanyPlugin } from "./account_company";
import { buyerPersonPlugin } from "./buyer_person";
import { AngelIndividualPlugin } from "./angel_individual";
import { LimitedPartnerPlugin } from "./limited_partner";
import { CoFounderMatchPlugin } from "./co_founder_match";
import { ExecutiveHirePlugin } from "./executive_hire";
import { EngineeringHirePlugin } from "./engineering_hire";
import { FractionalExecutivePlugin } from "./fractional_executive";
import { ChannelPartnerPlugin } from "./channel_partner";
import { IntegrationPartnerPlugin } from "./integration_partner";
import { DesignPartnerPlugin } from "./design_partner";
import { BetaTesterPlugin } from "./beta_tester";
import { JournalistAnalystPlugin } from "./journalist_analyst";
import { ThoughtLeaderPlugin } from "./thought_leader";
import { AcademicResearcherPlugin } from "./academic_researcher";
import { GovernmentGrantOfficerPlugin } from "./government_grant_officer";
import { RegulatorPlugin } from "./regulator";
import { PolicyAdvisorPlugin } from "./policy_advisor";
import { ServiceProviderPlugin } from "./service_provider";
import { AcquirerPlugin } from "./acquirer";
import { CompetitorPlugin } from "./competitor";
const REGISTRY_MAP = {
    account_company: accountCompanyPlugin,
    buyer_person: buyerPersonPlugin,
    investor_person: investorPersonPlugin,
    investor_firm: investorFirmPlugin,
    venture_partner: venturePartnerPlugin,
    founder: founderPlugin,
    angel_individual: AngelIndividualPlugin,
    limited_partner: LimitedPartnerPlugin,
    co_founder_match: CoFounderMatchPlugin,
    executive_hire: ExecutiveHirePlugin,
    engineering_hire: EngineeringHirePlugin,
    fractional_executive: FractionalExecutivePlugin,
    channel_partner: ChannelPartnerPlugin,
    integration_partner: IntegrationPartnerPlugin,
    design_partner: DesignPartnerPlugin,
    beta_tester: BetaTesterPlugin,
    journalist_analyst: JournalistAnalystPlugin,
    thought_leader: ThoughtLeaderPlugin,
    academic_researcher: AcademicResearcherPlugin,
    government_grant_officer: GovernmentGrantOfficerPlugin,
    regulator: RegulatorPlugin,
    policy_advisor: PolicyAdvisorPlugin,
    service_provider: ServiceProviderPlugin,
    acquirer: AcquirerPlugin,
    competitor: CompetitorPlugin,
};
// Sanity check: every declared kind has a plugin file. If a future
// kind is added to taxonomy without a wrapper, surface it at boot.
for (const k of ALL_KIND_KEYS) {
    if (!REGISTRY_MAP[k])
        throw new Error(`missing plugin file for kind=${k}`);
}
export function getPluginFor(rawKind) {
    const k = resolveKind(rawKind) ?? "account_company";
    return REGISTRY_MAP[k];
}
export { KINDS, ALL_KIND_KEYS, resolveKind };
export * from "./taxonomy";
