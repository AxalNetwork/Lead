import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import { assertBudget } from "../../../../ai/budget";
import { limitAi } from "../../../rateLimit";
import { aiCacheGet, aiCachePut, sha256Hex } from "../../../../ai/cache";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, importKey, type AggregatorHints } from "./_base";

/**
 * Generic HTML list importer (`aggregators/genericHtml.ts`) — last-
 * resort fallback for any URL the dispatcher can't route to a
 * site-specific importer.
 *
 * Algorithm:
 *   1. Fetch + render the page.
 *   2. Detect candidate "list containers" — any element with ≥ 5
 *      direct children sharing a tag + class signature.
 *   3. Send the visible text of the top container to Workers AI
 *      (`@cf/meta/llama-3.1-8b-instruct-fast`, JSON-schema response)
 *      to extract `{records: [{name, role?, firm?, url?, location?,
 *      email?, linkedin?, twitter?, notes?}]}`.
 *   4. Cross-check positional `<a href>` against each name and surface
 *      a confidence score per record. Low-confidence rows still go
 *      through but are flagged via a `low_confidence:{name}` entry in
 *      `errors[]` so the dashboard's review queue can render them.
 *
 * The importer fail-soft when the AI binding is unavailable or the
 * page yields no list container — it returns `{firms: [], totalSeen:
 * 0, errors: [...]}` instead of throwing.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_CONTAINER_CHARS = 6500;
const MIN_CHILDREN = 5;
const LOW_CONFIDENCE_THRESHOLD = 0.6;

const RECORDS_SCHEMA = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          firm: { type: "string" },
          url: { type: "string" },
          location: { type: "string" },
          email: { type: "string" },
          linkedin: { type: "string" },
          twitter: { type: "string" },
          notes: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["name"],
      },
    },
  },
  required: ["records"],
} as const;

interface AiRecord {
  name: string;
  role?: string;
  firm?: string;
  url?: string;
  location?: string;
  email?: string;
  linkedin?: string;
  twitter?: string;
  notes?: string;
  confidence?: number;
}

export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }
  const html = fetched.html;

  const container = pickListContainer(html);
  if (!container) {
    return { firms: [], totalSeen: 0, errors: ["no_list_container_detected"] };
  }

  // Build the AI prompt body from the container's visible text +
  // positional anchor manifest (so the LLM can match name → url).
  const anchors = extractAnchors(container.html, url).slice(0, 60);
  const visibleText = decodeEntities(container.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, MAX_CONTAINER_CHARS);
  const anchorManifest = anchors.map((a, i) => `${i + 1}. ${a.text || "(no text)"} → ${a.href}`).join("\n").slice(0, 1500);

  // Check cache before budget/rate-limit so previously-extracted pages
  // fail soft when AI is throttled or out of budget. Only enforce gates
  // on the live-call path below.
  const cacheKey = await sha256Hex(`${MODEL}:generic-html:${visibleText}|${anchorManifest}`);
  let aiRecords: AiRecord[] | null = await aiCacheGet<AiRecord[]>(env, cacheKey);

  if (!aiRecords) {
    if (!env.AI) {
      return { firms: [], totalSeen: 0, errors: ["ai_binding_unavailable"] };
    }
    const budget = await assertBudget(env, "ai");
    if (!budget.ok) {
      return { firms: [], totalSeen: 0, errors: ["ai_budget_exhausted"] };
    }
    if (!(await limitAi(env))) {
      return { firms: [], totalSeen: 0, errors: ["ai_rate_limited"] };
    }
    try {
      const res = (await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You extract a list of people or firms from one HTML list container. " +
              "Return strict JSON {records: [...]}. Each record needs `name` plus any of " +
              "role, firm, url, location, email, linkedin, twitter, notes. Cross-check " +
              "anchor URLs in the manifest against names — when a record's url is the same " +
              "as an anchor that immediately follows the name, set confidence ≥ 0.8. " +
              "When the name is ambiguous (could be a city or a section header) drop confidence to ≤ 0.5.",
          },
          {
            role: "user",
            content: `URL: ${url}\n\nVisible list text:\n${visibleText}\n\nAnchor manifest:\n${anchorManifest}`,
          },
        ],
        response_format: { type: "json_schema", json_schema: RECORDS_SCHEMA },
      })) as { response?: string; records?: AiRecord[] };
      aiRecords = parseRecordsResponse(res);
    } catch (e) {
      return { firms: [], totalSeen: 0, errors: [`ai_extract_failed:${(e as Error).message}`] };
    }
    await aiCachePut(env, cacheKey, aiRecords);
  }

  if (!aiRecords.length) {
    return { firms: [], totalSeen: 0, errors: ["ai_returned_no_records"] };
  }

  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const lowConfidence: string[] = [];

  for (const r of aiRecords) {
    const name = (r.name || "").trim();
    if (!name || name.length < 2 || name.length > 200) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const conf = typeof r.confidence === "number" ? r.confidence : 0.55;
    const row: Record<string, unknown> = { name };
    if (r.url) row.website = r.url;
    if (r.firm && !r.url) row.notes = `firm: ${r.firm}`;
    if (r.role) row.kind = r.role;
    if (r.location) row.city = r.location;
    if (r.email) row.email = r.email;
    if (r.linkedin) row.LinkedIn = r.linkedin;
    if (r.twitter) row.Twitter = r.twitter;
    const cand = rowToCandidate(row, url);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("generic_html", name);
    if (conf < LOW_CONFIDENCE_THRESHOLD) {
      lowConfidence.push(`low_confidence:${name}:${conf.toFixed(2)}`);
      // Stash the confidence in `notes` so a reviewer can see it.
      const existing = (cand.candidate.notes as string | undefined) ?? "";
      cand.candidate.notes = existing
        ? `${existing}\nconfidence:${conf.toFixed(2)}`
        : `confidence:${conf.toFixed(2)}`;
    }
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, hints);
  return {
    firms,
    totalSeen: aiRecords.length,
    errors: lowConfidence.length ? lowConfidence : undefined,
  };
}

function parseRecordsResponse(res: unknown): AiRecord[] {
  const r = res as { response?: string; records?: unknown };
  if (Array.isArray(r?.records)) return (r.records as AiRecord[]).filter((x) => x && typeof x.name === "string");
  if (typeof r?.response === "string") {
    try {
      const j = JSON.parse(r.response) as { records?: AiRecord[] };
      if (Array.isArray(j?.records)) return j.records.filter((x) => x && typeof x.name === "string");
    } catch { /* fall through */ }
  }
  return [];
}

interface ContainerPick {
  html: string;
  childCount: number;
}

/**
 * Find the largest element whose direct children share a common tag +
 * class signature, with at least MIN_CHILDREN children. Returns the
 * inner HTML of that element. A naive scan is sufficient because we
 * only need *a* candidate, not the optimal one.
 */
function pickListContainer(html: string): ContainerPick | null {
  // Match outer elements that look like list containers (ul/ol/div/section).
  const re = /<(ul|ol|div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let best: ContainerPick | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[2];
    if (inner.length < 200 || inner.length > 50000) continue;
    const childTags = [...inner.matchAll(/<(li|article|div|tr)\b[^>]*(class=["']([^"']*)["'])?[^>]*>/gi)];
    if (childTags.length < MIN_CHILDREN) continue;
    // Group by `tag|firstClassToken`.
    const sig = new Map<string, number>();
    for (const c of childTags) {
      const tag = c[1].toLowerCase();
      const cls = (c[3] || "").split(/\s+/)[0] || "";
      const key = `${tag}|${cls}`;
      sig.set(key, (sig.get(key) ?? 0) + 1);
    }
    let top = 0;
    for (const v of sig.values()) if (v > top) top = v;
    if (top < MIN_CHILDREN) continue;
    if (!best || top > best.childCount) best = { html: inner, childCount: top };
  }
  return best;
}
