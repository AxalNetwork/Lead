// Task #3: investor_person kind plugin.
//
// Acceptance criteria: matches entities where type='person' AND
// entity_roles.role IN ('investor','vc','gp','partner_at_firm'),
// then filters by firm size / stage / sector criteria via the
// existing person-graph scorer (which already considers employer
// sectors / stages / employees from career_history + entity_summary).

import { makeGenericPlugin } from "./_generic";
import type { KindCriteriaPlugin } from "./_generic";

// The generic plugin's defaultEntityFilter already picks up the
// taxonomy's role list ['investor','vc','gp','partner_at_firm'] and
// the person scorer already weighs employer sector / stage / size.
// We export it under a stable name so the registry can swap in a
// bespoke implementation later without touching the registry wiring.
export const investorPersonPlugin: KindCriteriaPlugin = makeGenericPlugin("investor_person");
