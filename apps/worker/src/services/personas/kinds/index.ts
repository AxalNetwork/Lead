// Task #3: persona-kind plugin registry + dispatcher entrypoint.
//
// The PersonaMatchingService reads the persona's kind, calls
// getPluginFor(kind), and delegates to defaultEntityFilter / scoreEntity.
// Kinds without a bespoke plugin file fall back to the generic plugin
// driven by the taxonomy's `roles` array (see _generic.ts).

import { ALL_KIND_KEYS, KINDS, resolveKind, type PersonaKind } from "./taxonomy";
import { makeGenericPlugin, type KindCriteriaPlugin } from "./_generic";
import { investorPersonPlugin } from "./investor_person";
import { investorFirmPlugin } from "./investor_firm";
import { venturePartnerPlugin } from "./venture_partner";
import { founderPlugin } from "./founder";
import { accountCompanyPlugin } from "./account_company";
import { buyerPersonPlugin } from "./buyer_person";

const BESPOKE: Partial<Record<PersonaKind, KindCriteriaPlugin>> = {
  account_company: accountCompanyPlugin,
  buyer_person: buyerPersonPlugin,
  investor_person: investorPersonPlugin,
  investor_firm: investorFirmPlugin,
  venture_partner: venturePartnerPlugin,
  founder: founderPlugin,
};

// Pre-materialize a plugin for every declared kind so callers never
// hit a missing-plugin branch.
const REGISTRY: Record<PersonaKind, KindCriteriaPlugin> = Object.fromEntries(
  ALL_KIND_KEYS.map((k) => [k, BESPOKE[k] ?? makeGenericPlugin(k)]),
) as Record<PersonaKind, KindCriteriaPlugin>;

export function getPluginFor(rawKind: string | null | undefined): KindCriteriaPlugin {
  const k = resolveKind(rawKind) ?? "account_company";
  return REGISTRY[k];
}

export { KINDS, ALL_KIND_KEYS, resolveKind };
export type { KindCriteriaPlugin, PersonaKind };
export * from "./taxonomy";
