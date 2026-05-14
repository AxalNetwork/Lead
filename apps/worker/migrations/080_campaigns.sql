-- Task 7: Campaigns + members.

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icp_id TEXT,
  channel TEXT NOT NULL,           -- 'email' | 'linkedin' | 'cold_call'
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | paused | done
  exporter TEXT,                   -- last format exported: csv|json|hubspot|lemlist|instantly
  exported_count INTEGER NOT NULL DEFAULT 0,
  exported_at TEXT,
  webhook_secret TEXT,             -- per-campaign HMAC secret (random)
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_icp ON campaigns(icp_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_created ON campaigns(created_at);

CREATE TABLE IF NOT EXISTS campaign_members (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sent|opened|clicked|replied|bounced|unsubscribed|meeting
  external_id TEXT,                -- id reported back by the marketing tool
  last_event_at TEXT,
  meta_json TEXT,
  added_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_lead ON campaign_members(campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_campaign_members_status ON campaign_members(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_members_lead ON campaign_members(lead_id);
