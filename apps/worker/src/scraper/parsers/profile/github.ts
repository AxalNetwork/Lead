// GitHub profile extractor. Uses the public REST API
// (https://api.github.com/users/{user}) which is unauthenticated-friendly
// (60 req/hour/IP), gives clean JSON, and matches GitHub ToS — much
// better than scraping the HTML profile page.

import type { Env, ParsedLead } from "../../../types";
import { extractDomain } from "../../normalize";

const HANDLE_RE = /^\/(?!orgs\/|topics\/|search|features|marketplace|pricing|sponsors|settings)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/?$/;

export function isGithubProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)github\.com$/i.test(u.hostname) && HANDLE_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function handleFromGithubUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = HANDLE_RE.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

interface GithubUser {
  login: string;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  bio: string | null;
  twitter_username: string | null;
  html_url: string;
  avatar_url: string | null;
  type: string;
}

export interface GithubParseResult {
  leads: ParsedLead[];
  status: number;
  ok: boolean;
}

export async function parseGithub(env: Env, url: string, jobId: string): Promise<GithubParseResult> {
  const handle = handleFromGithubUrl(url);
  if (!handle) return { leads: [], status: 0, ok: false };
  // Note: we deliberately don't go through fetchPage — this is a JSON API
  // and the tier escalation chain would be wrong for it. We log a manual
  // fetch_log row so /api/scrapers/health still reflects the request.
  const apiUrl = `https://api.github.com/users/${encodeURIComponent(handle)}`;
  const start = Date.now();
  let user: GithubUser | null = null;
  let status = 0;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "AIDataSignalBot/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    status = res.status;
    if (res.ok) user = (await res.json()) as GithubUser;
  } catch {
    status = 0;
  }
  try {
    await env.DB.prepare(
      `INSERT INTO fetch_log (job_id, host, url, tier, status, bytes, block_reason, duration_ms, cost_usd, created_at)
       VALUES (?, 'api.github.com', ?, 0, ?, 0, ?, ?, 0, ?)`,
    ).bind(jobId, apiUrl, status, status >= 200 && status < 400 ? null : `status_${status}`, Date.now() - start, new Date().toISOString()).run();
  } catch {
    // logging is best-effort
  }
  if (!user) return { leads: [], status, ok: false };

  const socials: Array<{ platform: string; url: string }> = [{ platform: "github", url: user.html_url }];
  if (user.twitter_username) {
    socials.push({ platform: "twitter", url: `https://twitter.com/${user.twitter_username}` });
  }
  if (user.blog) {
    const blogUrl = user.blog.startsWith("http") ? user.blog : `https://${user.blog}`;
    socials.push({ platform: "personal", url: blogUrl });
  }

  return {
    leads: [
      {
        source_domain: extractDomain(url),
        source_url: url,
        name: user.name || user.login,
        email: user.email || undefined,
        org: user.company || undefined,
        title: user.type === "User" ? undefined : user.type,
        category: "github_profile",
        meta: {
          parser: "profile/github",
          github_login: user.login,
          github_url: user.html_url,
          location: user.location,
          bio: user.bio,
          blog: user.blog,
          twitter_username: user.twitter_username,
          avatar_url: user.avatar_url,
          socials,
        },
      },
    ],
    status,
    ok: true,
  };
}
