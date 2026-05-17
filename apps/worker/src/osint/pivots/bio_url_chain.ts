// Bio-URL chaining pivot.
//
// For each known social profile, fetch the public HTML and harvest any
// outbound URLs in the bio/description/sameAs JSON-LD. Each chained URL
// that parses into a known platform handle is emitted as a bio_url hit
// with medium-high confidence (the user themselves placed the link).

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGetCached, pastDeadline, parallelMap } from "./_util";
import { getPlatform, parseProfileUrl } from "../platforms";

const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;

export async function runBioUrlChain(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const hits: PivotHit[] = [];
  const known = facts.knownHandles.slice(0, 5);
  if (!known.length) return [];

  await parallelMap(known, 3, async (kh) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const def = getPlatform(kh.platform);
    if (!def) return;
    const url = kh.url ?? def.urlOf(kh.handle);
    const res = await simpleGetCached(env, url, { timeoutMs: 5000 });
    if (!res.ok || !res.text) return;

    // Extract JSON-LD sameAs blocks first (high signal)
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = ldRe.exec(res.text)) !== null) {
      try {
        const obj = JSON.parse(m[1].trim());
        const list = collectSameAs(obj);
        for (const target of list) {
          const p = parseProfileUrl(target);
          if (p && !sameAsKnown(facts, p)) {
            hits.push({
              platform: p.platform,
              handle: p.handle,
              url: target,
              link_method: "same_as",
              base_confidence: 0.88,
              evidence_json: { source_platform: kh.platform, source_url: url, channel: "json_ld" },
            });
          }
        }
      } catch { /* ignore malformed */ }
    }

    // Fallback: raw URL scan inside the document. We trim very common false-
    // positive hosts. Confidence is lower because anyone could embed a URL.
    const seen = new Set<string>();
    const found = res.text.match(URL_RE) ?? [];
    for (const raw of found.slice(0, 200)) {
      const cleaned = raw.replace(/[.,;)]+$/, "");
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      const p = parseProfileUrl(cleaned);
      if (p && !sameAsKnown(facts, p)) {
        hits.push({
          platform: p.platform,
          handle: p.handle,
          url: cleaned,
          link_method: "bio_url",
          base_confidence: 0.70,
          evidence_json: { source_platform: kh.platform, source_url: url, channel: "html_scan" },
        });
      }
    }
  });

  return hits;
}

function collectSameAs(obj: unknown, out: string[] = []): string[] {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { for (const x of obj) collectSameAs(x, out); return out; }
  const o = obj as Record<string, unknown>;
  const sa = o.sameAs;
  if (typeof sa === "string") out.push(sa);
  else if (Array.isArray(sa)) for (const s of sa) if (typeof s === "string") out.push(s);
  for (const k of Object.keys(o)) {
    if (typeof o[k] === "object") collectSameAs(o[k], out);
  }
  return out;
}

function sameAsKnown(facts: KnownEntityFacts, p: { platform: string; handle: string }): boolean {
  return facts.knownHandles.some((h) => h.platform === p.platform && h.handle.toLowerCase() === p.handle.toLowerCase());
}
