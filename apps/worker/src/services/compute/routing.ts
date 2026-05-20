// Task #9: Routing matrix.
//
// SINGLE SOURCE OF TRUTH precedent (documented in replit.md): code
// defaults below are the canonical routing rules; per-deployment
// overrides live in `compute_nodes.capabilities_json` (e.g.
// {allow_all_kinds: true} to opt a single CPU box into a gpu-preferred
// job). Routes that flip `external_ok=false` stay in-Workers always
// (small classify-style jobs where the round-trip cost dwarfs gain).

export type NodeKind = "cpu" | "gpu" | "browser";

export type JobType =
  | "crawl"
  | "extract_html"
  | "llm_classify"
  | "embed_text"
  | "vision_ocr"
  | "transcribe_audio"
  | "render_browser";

export interface RoutingRule {
  /** Ordered kind preference; first match wins on tiebreak. */
  preferred_kinds: NodeKind[];
  /** When true, dispatcher tries external first; false → in-Workers stays primary. */
  prefer_external: boolean;
  /** When false, never route this job_type externally regardless. */
  external_ok: boolean;
  /** Per-job soft deadline (ms). Watchdog times out elapsed assignments. */
  deadline_ms: number;
}

export const DEFAULT_ROUTING_MATRIX: Record<JobType, RoutingRule> = {
  // Light HTTP work — stays on Workers unless an operator deliberately
  // adds a node to take the offload.
  crawl:            { preferred_kinds: ["cpu"],          prefer_external: false, external_ok: true,  deadline_ms:  60_000 },
  extract_html:     { preferred_kinds: ["cpu"],          prefer_external: false, external_ok: true,  deadline_ms:  60_000 },
  // Small classifies stay on Workers AI per spec; large prompts (caller
  // sets prefer_external in the routing override) go external.
  llm_classify:     { preferred_kinds: ["gpu", "cpu"],   prefer_external: false, external_ok: true,  deadline_ms: 120_000 },
  // Bulk embedding — gpu strongly preferred but cpu acceptable.
  embed_text:       { preferred_kinds: ["gpu", "cpu"],   prefer_external: true,  external_ok: true,  deadline_ms: 120_000 },
  // Vision / audio always external — Workers CPU budget can't handle.
  vision_ocr:       { preferred_kinds: ["gpu", "cpu"],   prefer_external: true,  external_ok: true,  deadline_ms: 300_000 },
  transcribe_audio: { preferred_kinds: ["gpu"],          prefer_external: true,  external_ok: true,  deadline_ms: 600_000 },
  render_browser:   { preferred_kinds: ["browser"],      prefer_external: true,  external_ok: true,  deadline_ms: 180_000 },
};

/** Merge a per-call override on top of the default rule. */
export function resolveRule(jobType: JobType, override?: Partial<RoutingRule>): RoutingRule {
  const base = DEFAULT_ROUTING_MATRIX[jobType] ?? {
    preferred_kinds: ["cpu"], prefer_external: false, external_ok: true, deadline_ms: 60_000,
  };
  if (!override) return base;
  return {
    preferred_kinds: override.preferred_kinds ?? base.preferred_kinds,
    prefer_external: override.prefer_external ?? base.prefer_external,
    external_ok:     override.external_ok     ?? base.external_ok,
    deadline_ms:     override.deadline_ms     ?? base.deadline_ms,
  };
}
