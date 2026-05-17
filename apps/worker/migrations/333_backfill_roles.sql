-- Task #2: backfill entity_roles so the Investors page (which now reads
-- via entity_roles) shows existing investors that were ingested before
-- the role-inference hook landed. Idempotent: every INSERT is
-- INSERT OR IGNORE with a NOT EXISTS guard, and the supporting seed
-- table is created on demand so the migration is safe to apply on
-- environments where Task #15's seed migration hasn't run yet.

CREATE TABLE IF NOT EXISTS known_investor_domains (
  domain TEXT PRIMARY KEY,
  label  TEXT,
  source TEXT
);

INSERT OR IGNORE INTO known_investor_domains (domain, label, source) VALUES
  ('a16z.com',              'Andreessen Horowitz', 'seed:task2'),
  ('andreessenhorowitz.com','Andreessen Horowitz', 'seed:task2'),
  ('sequoiacap.com',        'Sequoia Capital',     'seed:task2'),
  ('accel.com',             'Accel',               'seed:task2'),
  ('kpcb.com',              'Kleiner Perkins',     'seed:task2'),
  ('benchmark.com',         'Benchmark',           'seed:task2'),
  ('greylock.com',          'Greylock',            'seed:task2'),
  ('firstround.com',        'First Round',         'seed:task2'),
  ('foundersfund.com',      'Founders Fund',       'seed:task2'),
  ('crv.com',               'CRV',                 'seed:task2'),
  ('usv.com',               'Union Square Ventures','seed:task2'),
  ('union.vc',              'Union',               'seed:task2'),
  ('indexventures.com',     'Index Ventures',      'seed:task2'),
  ('sparkcapital.com',      'Spark Capital',       'seed:task2'),
  ('generalcatalyst.com',   'General Catalyst',    'seed:task2'),
  ('incubatefund.com',      'Incubate Fund',       'seed:task2');

-- (1) Firms whose primary_domain matches the known investor list → investor_firm.
INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor_firm', 1, 'backfill:known_investor_domain', 1
  FROM u_entities e
  JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'firms'
 WHERE EXISTS (
   SELECT 1 FROM known_investor_domains k
    WHERE LOWER(k.domain) = LOWER(COALESCE(e.primary_domain, ''))
 )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor_firm');

-- (2) Leads (persons) whose org / source_domain / email-domain / employer firm
-- domain matches the known investor list → investor. We match multiple ways
-- because `leads.org` typically carries the human firm name (e.g. "Incubate
-- Fund") rather than a domain; we therefore also pivot through the firms
-- table to recover the firm's domain.
INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor', 1, 'backfill:known_investor_domain', 1
  FROM u_entities e
  JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
  JOIN leads l ON l.id = m.legacy_id
 WHERE e.kind = 'person'
   AND (
     -- direct match on org/source_domain (legacy)
     LOWER(COALESCE(l.org, '')) IN (SELECT LOWER(domain) FROM known_investor_domains)
     OR LOWER(COALESCE(l.source_domain, '')) IN (SELECT LOWER(domain) FROM known_investor_domains)
     -- email host matches a known investor domain
     OR (l.email IS NOT NULL
          AND LOWER(SUBSTR(l.email, INSTR(l.email, '@') + 1)) IN (SELECT LOWER(domain) FROM known_investor_domains))
     -- person works at a firm whose primary domain is in the known list
     OR EXISTS (
       SELECT 1 FROM firms f
        WHERE LOWER(f.name) = LOWER(COALESCE(l.org, ''))
          AND LOWER(COALESCE(f.domain, '')) IN (SELECT LOWER(domain) FROM known_investor_domains)
     )
   )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor');

-- (3) Partner/principal title at an investor_firm (inherited via the
-- person's company entity, not the person itself). The person is
-- linked to a firm via leads.org → firms.name → entity_legacy_map.
INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor', 1, 'backfill:partner_title_at_investor_firm', 0.85
  FROM u_entities e
  JOIN entity_legacy_map m  ON m.entity_id  = e.id AND m.legacy_table = 'leads'
  JOIN leads l               ON l.id        = m.legacy_id
  JOIN firms f               ON LOWER(f.name) = LOWER(COALESCE(l.org, ''))
  JOIN entity_legacy_map mf  ON mf.legacy_table = 'firms' AND mf.legacy_id = CAST(f.id AS TEXT)
  JOIN entity_roles rf       ON rf.entity_id = mf.entity_id AND rf.role = 'investor_firm'
 WHERE e.kind = 'person'
   AND (
     LOWER(COALESCE(l.title, '')) LIKE '%partner%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%principal%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%associate%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%venture%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%investor%'
     OR LOWER(COALESCE(l.title, '')) LIKE '% gp%'
     OR LOWER(COALESCE(l.title, '')) LIKE 'gp %'
     OR LOWER(COALESCE(l.title, '')) LIKE '%managing director%'
   )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor');
