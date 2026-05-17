INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor_firm', 1, 'backfill:known_investor_domain', 1
  FROM u_entities e
  JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'firms'
 WHERE EXISTS (
   SELECT 1 FROM known_investor_domains k
    WHERE LOWER(k.domain) = LOWER(COALESCE(e.primary_domain, ''))
 )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor_firm');

INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor', 1, 'backfill:known_investor_domain', 1
  FROM u_entities e
  JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
 WHERE e.kind = 'person'
   AND EXISTS (
     SELECT 1 FROM leads l
      WHERE l.id = m.legacy_id
        AND (
          LOWER(COALESCE(l.org, '')) IN (SELECT LOWER(domain) FROM known_investor_domains)
          OR LOWER(COALESCE(l.source_domain, '')) IN (SELECT LOWER(domain) FROM known_investor_domains)
        )
   )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor');

INSERT OR IGNORE INTO entity_roles (entity_id, role, is_primary, source, confidence)
SELECT e.id, 'investor', 1, 'backfill:partner_title', 0.8
  FROM u_entities e
  JOIN entity_legacy_map m ON m.entity_id = e.id AND m.legacy_table = 'leads'
  JOIN leads l ON l.id = m.legacy_id
 WHERE e.kind = 'person'
   AND EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor_firm')
   AND (
     LOWER(COALESCE(l.title, '')) LIKE '%partner%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%principal%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%associate%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%venture%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%investor%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%gp%'
     OR LOWER(COALESCE(l.title, '')) LIKE '%md%'
   )
   AND NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role = 'investor');
