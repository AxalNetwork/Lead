// Task #6: queue-level preflight gating.
//
// Runs BEFORE runJob dispatches into the scraper pipeline. Short-circuits
// jobs that would obviously fail — missing PROXY_URL, open circuit
// breaker, ToS-blocked host, or gated source needing operator paste —
// into the new `skipped` terminal status with a single `skip_reason`
// row on `jobs`. Skipped jobs DO NOT write to `error_log`: that table
// is reserved for unexpected failures (the cluster surface).
//
// The fetcher (scraper/fetcher.ts) keeps its existing internal blocks
// as a defense-in-depth backstop; this preflight is layered in front
// and never replaces them.
//
// Gates:
//   - proxy_not_configured       — env.PROXY_URL unset, kind needs proxy
//   - circuit_open               — isCircuitOpen(host) returns a reason
//   - tos_blocked                — tosBlockedReason(host) is non-null
//   - gated_source_use_manual_paste — URL matches a known gated source
//                                     (NFX today; extensible)
//
// Skip codes are deliberately stable strings (no host suffix in the
// enum itself) so the ops dashboard `skipped_by_reason` tally rolls
// up cleanly. The full per-URL reason (e.g. "tos_blocked:tiktok.com")
// is kept in `jobs.error` for debugging; the canonical enum lives in
// `jobs.skip_reason`.

import type { Env, JobMessage } from "../types";
import { tosBlockedReason } from "./tos";
import { isCircuitOpen } from "./circuit_breaker";
import { isNfxProfileUrl } from "./parsers/profile/nfx";
import { hasAnyProxy } from "./proxyPool";

export type SkipCode =
  | "proxy_not_configured"
  | "circuit_open"
  | "tos_blocked"
  | "gated_source_use_manual_paste";

export interface PreflightSkip {
  action: "skip";
  skip_code: SkipCode;
  reason: string;
  host: string | null;
  url: string | null;
}
export interface PreflightRun {
  action: "run";
}
export type PreflightResult = PreflightRun | PreflightSkip;

// Job kinds whose pipeline routes through `fetchPage` -> tier2Proxy.
// csv_import / parse_file / import_file / enrich_lead / enrich_company
// never touch the proxy gate, so PROXY_URL absence is not a blocker
// for them. We intentionally allow-list: a new kind that fetches must
// explicitly opt in here.
const PROXY_DEPENDENT_KINDS = new Set<string>([
  "url",
  "crawl_url",
  "linktree",
  "profile_list",
  "discover",
  "firmlist",
  "firm_team_crawl",
]);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Return true if the job's `target` is a URL that the pipeline will
 * actually try to fetch. profile_list jobs with `enrich_kind` set are
 * lead/company-id targets, not URLs, and route to enrichLead /
 * company-enrich-noop — skip the proxy/circuit/tos gates for them.
 */
function isUrlTarget(msg: JobMessage): boolean {
  if (!PROXY_DEPENDENT_KINDS.has(msg.kind as string)) return false;
  if (msg.kind === "profile_list") {
    const cfg = msg.config as { enrich_kind?: string } | undefined;
    if (cfg?.enrich_kind === "investor" || cfg?.enrich_kind === "company") {
      return false;
    }
  }
  try {
    const u = new URL(msg.target);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function preflight(env: Env, msg: JobMessage): Promise<PreflightResult> {
  if (!isUrlTarget(msg)) return { action: "run" };

  const url = msg.target;
  const host = hostOf(url);

  // 1. Gated-source check — NFX and similar that require operator paste.
  //    Cheap (string match, no I/O), so run first.
  if (isNfxProfileUrl(url)) {
    return {
      action: "skip",
      skip_code: "gated_source_use_manual_paste",
      reason: `gated_source_use_manual_paste:${host ?? "unknown"}`,
      host,
      url,
    };
  }

  // 2. ToS denylist (data/tos-flags.json via tosBlockedReason).
  if (host) {
    const tos = tosBlockedReason(host);
    if (tos) {
      return {
        action: "skip",
        skip_code: "tos_blocked",
        reason: tos,
        host,
        url,
      };
    }
  }

  // 3. Proxy gate — only when the pipeline actually needs the proxy
  //    tier. We can't tell tier-1/tier-0-only from here (the fetcher
  //    escalates dynamically), so the conservative answer is: if NO
  //    proxy provider is configured AND the kind is proxy-dependent,
  //    skip. Task #16: any configured provider (generic / Smartproxy /
  //    Bright Data / Oxylabs) makes the job runnable.
  if (!hasAnyProxy(env)) {
    return {
      action: "skip",
      skip_code: "proxy_not_configured",
      reason: "proxy_not_configured:no proxy provider secret set",
      host,
      url,
    };
  }

  // 4. Per-host circuit breaker — single PK lookup; cheap.
  if (host) {
    const breaker = await isCircuitOpen(env, host);
    if (breaker) {
      return {
        action: "skip",
        skip_code: "circuit_open",
        reason: breaker,
        host,
        url,
      };
    }
  }

  return { action: "run" };
}

/** Per-kind set used by tests + ops surface. Exported for inspection. */
export const PROXY_KINDS: ReadonlySet<string> = PROXY_DEPENDENT_KINDS;
