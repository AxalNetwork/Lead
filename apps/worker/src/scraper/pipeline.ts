import type { Env, JobMessage, ParsedLead } from "../types";
import { fetchPage } from "./fetcher";
import { selectParser } from "./parsers";
import { extractDomain } from "./normalize";

const RAW_HTML_PREFIX = "raw";

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isCancelled(env: Env, jobId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
  return r?.status === "cancelled";
}

async function markRunning(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
  )
    .bind(new Date().toISOString(), jobId)
    .run();
}

async function markFailed(env: Env, jobId: string, error: string, costMs: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, cost_ms = COALESCE(cost_ms,0) + ? WHERE id = ?",
  )
    .bind(error.slice(0, 1000), new Date().toISOString(), costMs, jobId)
    .run();
}

async function markCompleted(
  env: Env,
  jobId: string,
  leadsFound: number,
  pagesFetched: number,
  pagesBlocked: number,
  captchaHits: number,
  costMs: number,
  result: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'completed', finished_at = ?, leads_found = ?, pages_fetched = ?, pages_blocked = ?, captcha_hits = ?, cost_ms = COALESCE(cost_ms,0) + ?, result_json = ? WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      leadsFound,
      pagesFetched,
      pagesBlocked,
      captchaHits,
      costMs,
      JSON.stringify(result),
      jobId,
    )
    .run();
}

async function archiveRawHtml(env: Env, url: string, html: string): Promise<string | null> {
  if (!html) return null;
  try {
    const hash = await sha256(url);
    const date = new Date().toISOString().slice(0, 10);
    const key = `${RAW_HTML_PREFIX}/${hash}/${date}.html`;
    await env.RAW_HTML.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    return key;
  } catch (e) {
    console.warn("R2 archive failed", (e as Error).message);
    return null;
  }
}

async function insertLead(env: Env, lead: ParsedLead, jobId: string): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = JSON.stringify({ ...(lead.meta ?? {}), job_id: jobId });
  await env.DB.prepare(
    `INSERT INTO leads
      (id, name, email, org, title, category, source_domain, source_url, status, verified, flagged, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      lead.name ?? null,
      lead.email ?? null,
      lead.org ?? null,
      lead.title ?? null,
      lead.category ?? null,
      lead.source_domain,
      lead.source_url,
      meta,
      now,
      now,
    )
    .run();
}

async function touchSource(env: Env, url: string): Promise<void> {
  const domain = extractDomain(url);
  if (!domain) return;
  const now = new Date().toISOString();
  // Upsert: insert if missing, otherwise just update last_scraped_at.
  await env.DB.prepare(
    `INSERT INTO sources (id, domain, kind, enabled, last_scraped_at, created_at)
     VALUES (?, ?, 'auto', 1, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET last_scraped_at = excluded.last_scraped_at`,
  )
    .bind(crypto.randomUUID(), domain, now, now)
    .run();
}

async function processSingleUrl(
  env: Env,
  jobId: string,
  url: string,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  let leadsFound = 0;
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;
  let costMs = 0;

  if (await isCancelled(env, jobId)) return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };

  const fetched = await fetchPage(env, url);
  costMs += fetched.durationMs;

  if (!fetched.ok) {
    pagesBlocked += 1;
    if (fetched.blockReason === "captcha") captchaHits += 1;
    throw new Error(`fetch_failed:${fetched.blockReason ?? "unknown"}:status=${fetched.status}`);
  }

  pagesFetched += 1;
  await archiveRawHtml(env, url, fetched.html);
  await touchSource(env, url);

  const { name: parserName, parser } = selectParser(url);
  const parsed = parser(fetched.html, fetched.url);

  for (const lead of parsed) {
    if (await isCancelled(env, jobId)) break;
    await insertLead(env, { ...lead, meta: { ...(lead.meta ?? {}), parser: parserName } }, jobId);
    leadsFound += 1;
  }

  return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };
}

async function processLinktree(
  env: Env,
  jobId: string,
  target: string,
  config: Record<string, unknown> | undefined,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  // Fetch the link-tree style page and emit one lead row for the page itself,
  // plus enqueue child kind='url' jobs for each outbound link. Child jobs go
  // through this same pipeline on the next consumer batch.
  let leadsFound = 0;
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;
  let costMs = 0;

  if (await isCancelled(env, jobId)) return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };

  const fetched = await fetchPage(env, target);
  costMs += fetched.durationMs;
  if (!fetched.ok) {
    pagesBlocked += 1;
    if (fetched.blockReason === "captcha") captchaHits += 1;
    throw new Error(`fetch_failed:${fetched.blockReason ?? "unknown"}`);
  }
  pagesFetched += 1;
  await archiveRawHtml(env, target, fetched.html);
  await touchSource(env, target);

  const parserName = (config?.parser as string | undefined) ?? "linktree";
  const { parser } = await import("./parsers").then((m) => ({
    parser: m.PARSERS[parserName] ?? m.PARSERS.generic,
  }));
  const parsed = parser(fetched.html, fetched.url);

  for (const lead of parsed) {
    if (await isCancelled(env, jobId)) break;
    await insertLead(env, { ...lead, meta: { ...(lead.meta ?? {}), parser: parserName } }, jobId);
    leadsFound += 1;

    const outbound = Array.isArray(lead.meta?.outbound) ? (lead.meta!.outbound as string[]) : [];
    for (const childUrl of outbound.slice(0, 50)) {
      const childId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
      )
        .bind(childId, `child:${childUrl}`, extractDomain(childUrl), childUrl, JSON.stringify({ parent: jobId }), now, now)
        .run();
      await env.LEAD_QUEUE.send({ jobId: childId, kind: "url", target: childUrl });
    }
  }

  return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };
}

/** Main entry point invoked by the queue consumer. */
export async function runJob(msg: JobMessage, env: Env): Promise<void> {
  const { jobId } = msg;
  await markRunning(env, jobId);

  const start = Date.now();
  try {
    let totals: { leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number };
    if (msg.kind === "linktree") {
      totals = await processLinktree(env, jobId, msg.target, msg.config);
    } else if (msg.kind === "profile_list") {
      // Same shape as linktree for now; the discovery task overrides this.
      totals = await processLinktree(env, jobId, msg.target, msg.config);
    } else {
      totals = await processSingleUrl(env, jobId, msg.target);
    }

    if (await isCancelled(env, jobId)) {
      await env.DB.prepare(
        `UPDATE jobs SET cost_ms = COALESCE(cost_ms,0) + ?, leads_found = ?, pages_fetched = ?, pages_blocked = ?, captcha_hits = ?, cancelled_at = ?, finished_at = ? WHERE id = ?`,
      )
        .bind(
          Date.now() - start,
          totals.leadsFound,
          totals.pagesFetched,
          totals.pagesBlocked,
          totals.captchaHits,
          new Date().toISOString(),
          new Date().toISOString(),
          jobId,
        )
        .run();
      return;
    }

    await markCompleted(
      env,
      jobId,
      totals.leadsFound,
      totals.pagesFetched,
      totals.pagesBlocked,
      totals.captchaHits,
      Date.now() - start,
      { kind: msg.kind, target: msg.target },
    );
  } catch (e) {
    await markFailed(env, jobId, (e as Error).message, Date.now() - start);
    throw e;
  }
}
