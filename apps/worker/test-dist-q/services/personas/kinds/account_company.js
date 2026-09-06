// Task #3: account_company kind plugin (legacy "account" kind).
//
// Sales-side accounts live in the legacy `accounts` table and are
// scored via personas/score.ts + persona_matches (Task #46), not via
// the u_entities person graph. This plugin exists so the dispatcher
// can identify the kind, but defaultEntityFilter returns an empty
// candidate set — the legacy code path in routes/personas.ts owns
// account rescoring end-to-end.
export const accountCompanyPlugin = {
    kind: "account_company",
    defaultEntityFilter(_persona, _opts) {
        // Legacy path: accounts are not in u_entities for persona matching.
        return { sql: `SELECT id FROM u_entities WHERE 1 = 0`, binds: [] };
    },
    async scoreEntity(_env, _persona, _entityId) { return null; },
    explainMatch(entityId) { return `account_company (legacy accounts table): entity=${entityId}`; },
};
