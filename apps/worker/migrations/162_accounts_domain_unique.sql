-- Task #45 follow-up: enforce per-domain uniqueness on accounts so
-- concurrent crawler resolveAccount() calls cannot create duplicate rows
-- for the same apex domain. Partial index leaves NULL domains alone (we
-- want multiple imported accounts without a known domain to coexist).
--
-- If pre-existing duplicate domains are present this migration will
-- fail; resolve them manually then re-run.

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_domain_unique
  ON accounts(domain)
  WHERE domain IS NOT NULL;
