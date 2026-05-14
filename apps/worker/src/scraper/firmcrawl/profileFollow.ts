// Enqueue follow-up jobs for social profile URLs surfaced during a firm
// team-page crawl. Critical rule: **never fetch LinkedIn directly**. We
// route LinkedIn to a Task #4 discovery job (which uses search engines),
// and Crunchbase to a kind='url' job that the existing crunchbase parser
// will pick up automatically via selectParser().

import type { Env } from "../../types";
import { tosBlockedReason } from "../tos";
import { extractDomain } from "../normalize";

function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Enqueue a Task #4 discovery job that searches for "{name} {firm}" so
 * downstream search-cache / registry probes can populate the lead's
 * LinkedIn/Crunchbase/Twitter footprint without us hitting LinkedIn.
 */
export async function enqueueLinkedinDiscovery(
  env: Env,
  parentJobId: string,
  personName: string,
  firmName: string,
  linkedinUrl: string,
): Promise<string | null> {
  if (!personName || !firmName) return null;
  const query = `${personName} ${firmName}`;
  const childId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'discover', ?, ?, ?, ?)`,
  ).bind(
    childId,
    `discover:${query}`,
    "search",
    query,
    JSON.stringify({
      mode: "persona",
      persona: query,
      parentJobId,
      seed_linkedin: linkedinUrl,
    }),
    now,
    now,
  ).run();
  await env.LEAD_QUEUE.send({
    jobId: childId,
    kind: "discover",
    target: query,
    config: { mode: "persona", persona: query, parentJobId, seed_linkedin: linkedinUrl },
  });
  return childId;
}

/**
 * Enqueue a kind='url' job for a Crunchbase person page. selectParser()
 * routes crunchbase.com hosts to the existing crunchbase parser.
 */
export async function enqueueCrunchbaseUrl(
  env: Env,
  parentJobId: string,
  crunchbaseUrl: string,
): Promise<string | null> {
  const host = safeHost(crunchbaseUrl);
  if (!host) return null;
  if (tosBlockedReason(host) !== null) return null;
  const childId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
  ).bind(
    childId,
    `crunchbase:${crunchbaseUrl}`,
    extractDomain(crunchbaseUrl) ?? host,
    crunchbaseUrl,
    JSON.stringify({ parentJobId }),
    now,
    now,
  ).run();
  await env.LEAD_QUEUE.send({
    jobId: childId,
    kind: "url",
    target: crunchbaseUrl,
    config: { parentJobId },
  });
  return childId;
}
