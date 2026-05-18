-- Task #3: Expand persona kinds taxonomy.
--
-- The personas.kind column has no CHECK constraint (just a default of
-- 'account') and is plain TEXT, so widening the accepted set requires
-- no schema change at the column level — the taxonomy is enforced at
-- the application layer (apps/worker/src/services/personas/kinds/).
--
-- This migration is intentionally additive + idempotent:
--   1. Backfill existing personas: 'account' → 'account_company',
--      'buyer' → 'buyer_person'. Falls back via LEGACY_KIND_MAP in
--      taxonomy.ts at read time for any row this UPDATE misses.
--   2. Document the canonical kind set in a helper view so DB-only
--      tooling (CLI dumps, BI) can introspect without code.
--   3. Hint fields (subtype, aum_band, stage_focus, founded_count,
--      prior_exits, domain_expertise) live under
--      hard_filters_json.hints.<field> — no new columns needed.

UPDATE personas SET kind = 'account_company' WHERE kind = 'account';
UPDATE personas SET kind = 'buyer_person'    WHERE kind = 'buyer';

-- Mirror the taxonomy in a read-only registry view for ops queries.
-- Application code reads from taxonomy.ts; this is documentation +
-- ad-hoc query support only.
CREATE TABLE IF NOT EXISTS persona_kinds_registry (
  kind TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  target_entity_kind TEXT NOT NULL,
  roles_csv TEXT NOT NULL,
  hints_csv TEXT NOT NULL DEFAULT ''
);

DELETE FROM persona_kinds_registry;
INSERT INTO persona_kinds_registry (kind, group_name, label, target_entity_kind, roles_csv, hints_csv) VALUES
  ('account_company',         'Sales',         'Account (company)',          'company', '',                                                  ''),
  ('buyer_person',            'Sales',         'Buyer (person)',             'person',  'buyer,decision_maker,champion',                     ''),
  ('investor_firm',           'Capital',       'Investor firm',              'fund',    'investor_firm',                                     'aum_band,stage_focus'),
  ('investor_person',         'Capital',       'Investor (person)',          'person',  'investor,vc,gp,partner_at_firm',                    'stage_focus'),
  ('angel_individual',        'Capital',       'Angel investor',             'person',  'angel,investor',                                    'domain_expertise'),
  ('limited_partner',         'Capital',       'Limited partner',            'person',  'limited_partner,lp',                                'aum_band'),
  ('venture_partner',         'Capital',       'Venture partner',            'person',  'venture_partner,advisor,scout',                     'subtype,domain_expertise'),
  ('founder',                 'People',        'Founder',                    'person',  'founder,ceo',                                       'founded_count,prior_exits,domain_expertise'),
  ('co_founder_match',        'People',        'Co-founder match',           'person',  'founder,engineer,designer',                         'domain_expertise,prior_exits'),
  ('executive_hire',          'People',        'Executive hire',             'person',  'executive,vp,c_suite',                              'domain_expertise'),
  ('engineering_hire',        'People',        'Engineering hire',           'person',  'engineer,ic',                                       'domain_expertise'),
  ('fractional_executive',    'People',        'Fractional executive',       'person',  'fractional,advisor,executive',                      'domain_expertise,prior_exits'),
  ('channel_partner',         'Partnerships',  'Channel partner',            'company', 'partner,reseller',                                  ''),
  ('integration_partner',     'Partnerships',  'Integration partner',        'company', 'partner,integration',                               ''),
  ('design_partner',          'Partnerships',  'Design partner',             'company', 'customer,prospect',                                 ''),
  ('beta_tester',             'Partnerships',  'Beta tester',                'company', 'customer,prospect,beta',                            ''),
  ('journalist_analyst',      'Influence',     'Journalist / analyst',       'person',  'journalist,analyst,press',                          'domain_expertise'),
  ('thought_leader',          'Influence',     'Thought leader',             'person',  'influencer,thought_leader,speaker',                 'domain_expertise'),
  ('academic_researcher',     'Influence',     'Academic researcher',        'person',  'researcher,academic,professor',                     'domain_expertise'),
  ('government_grant_officer','Public Sector', 'Government grant officer',   'person',  'government,grant_officer,program_officer',          'domain_expertise'),
  ('regulator',               'Public Sector', 'Regulator',                  'person',  'regulator,agency_official',                         'domain_expertise'),
  ('policy_advisor',          'Public Sector', 'Policy advisor',             'person',  'policy_advisor,staffer,aide',                       'domain_expertise'),
  ('service_provider',        'Operational',   'Service provider',           'company', 'vendor,service_provider,agency',                    'domain_expertise'),
  ('acquirer',                'Operational',   'Acquirer',                   'company', 'acquirer,strategic',                                'aum_band'),
  ('competitor',              'Operational',   'Competitor',                 'company', 'competitor',                                        '');

CREATE INDEX IF NOT EXISTS idx_persona_kinds_registry_group ON persona_kinds_registry(group_name);
