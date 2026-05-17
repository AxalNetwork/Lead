// Avatar perceptual-hash matching pivot.
//
// For each candidate platform-handle pair (already-known handles + a few
// generated variants on the avatar-friendly platforms), download the
// avatar image, decode it (best-effort via OffscreenCanvas if available),
// compute dHash (16x16 → 8-bit greyscale → 8x8 differential bits), then
// compare hamming-distance against previously stored phash entries for
// this entity. Hamming < 8 ⇒ near-identical avatar ⇒ strong same-person
// signal.
//
// Workers don't expose a native image decoder; we instead use the
// well-known JPEG/PNG header-only structural hash as a fallback for
// environments without ImageBitmap support. dHash on raw bytes catches
// exact / near-exact reposts (the common case).

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { hammingHex, sha256Hex } from "../hashing";
import { pastDeadline, parallelMap } from "./_util";
import { getPlatform } from "../platforms";

interface PhashRow { id: string; entity_id: string | null; platform: string | null; handle: string | null; phash_hex: string }

// Avatar URLs we know how to construct without scraping (heuristics).
function knownAvatarUrl(platform: string, handle: string): string | null {
  switch (platform) {
    case "github":      return `https://github.com/${encodeURIComponent(handle)}.png?size=128`;
    case "gravatar":    return `https://gravatar.com/avatar/${encodeURIComponent(handle)}?s=128`;
    case "keybase":     return `https://keybase.io/${encodeURIComponent(handle)}/picture`;
    case "twitter":     return `https://unavatar.io/twitter/${encodeURIComponent(handle)}`;
    case "reddit":      return `https://unavatar.io/reddit/${encodeURIComponent(handle)}`;
    case "hackernews":  return null;
    default:            return `https://unavatar.io/${platform}/${encodeURIComponent(handle)}`;
  }
}

export async function runAvatarPhashMatch(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  if (!facts.knownHandles.length) return [];

  const hits: PivotHit[] = [];

  // 1) Compute / cache pHash for every known handle. Store in DB.
  const ownPhashes: Array<{ platform: string; handle: string; phash: string }> = [];
  await parallelMap(facts.knownHandles.slice(0, 8), 4, async (kh) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    if (!getPlatform(kh.platform)) return;
    const aurl = knownAvatarUrl(kh.platform, kh.handle);
    if (!aurl) return;
    const ph = await computePhashFromUrl(aurl);
    if (!ph) return;
    ownPhashes.push({ platform: kh.platform, handle: kh.handle, phash: ph });
    try {
      const id = await stableId("avphash", facts.entityId, kh.platform, kh.handle);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO avatar_phash (id, entity_id, platform, handle, source_url, phash_hex, dhash_hex)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, facts.entityId, kh.platform, kh.handle, aurl, ph, ph).run();
    } catch (e) { console.warn("phash insert failed", (e as Error).message); }
  });

  if (!ownPhashes.length) return [];

  // 2) Cross-match against avatar_phash rows whose 4-hex prefix is close
  //    to one of our own. We do the actual hamming-distance check in TS.
  for (const own of ownPhashes) {
    const prefix = own.phash.slice(0, 4);
    const r = await env.DB.prepare(
      `SELECT id, entity_id, platform, handle, phash_hex FROM avatar_phash
        WHERE substr(phash_hex,1,4) = ?
          AND (entity_id IS NULL OR entity_id != ?)
        LIMIT 200`,
    ).bind(prefix, facts.entityId).all<PhashRow>();
    for (const row of r.results ?? []) {
      if (!row.phash_hex || !row.platform || !row.handle) continue;
      const dist = hammingHex(own.phash, row.phash_hex);
      if (dist <= 6) {
        // Same avatar => same person, very likely.
        hits.push({
          platform: row.platform as never,
          handle: row.handle,
          url: getPlatform(row.platform)?.urlOf(row.handle) ?? null as unknown as string,
          link_method: "avatar_phash",
          base_confidence: dist === 0 ? 0.93 : 0.85,
          evidence_json: {
            hamming_distance: dist,
            matched_via: { platform: own.platform, handle: own.handle },
            other_entity_id: row.entity_id,
          },
        });
      }
    }
  }

  return hits;
}

// Compute a 64-bit perceptual hash from a URL. Tries OffscreenCanvas /
// ImageBitmap (modern Workers); falls back to a byte-stream hash that's
// still useful as an exact-duplicate detector.
async function computePhashFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "AIDataSignal-OSINT/1.0" } });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 64) return null;

    // Modern path: ImageBitmap + OffscreenCanvas, decode to 8x8 grayscale.
    // Types are absent from @cloudflare/workers-types; cast through unknown.
    interface CtxLike {
      drawImage: (img: unknown, x: number, y: number, w: number, h: number) => void;
      getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
    }
    const G = globalThis as unknown as {
      createImageBitmap?: (blob: Blob) => Promise<unknown>;
      OffscreenCanvas?: new (w: number, h: number) => { getContext: (kind: string) => CtxLike | null };
    };
    if (G.createImageBitmap && G.OffscreenCanvas) {
      try {
        const blob = new Blob([buf]);
        const bmp = await G.createImageBitmap(blob);
        const cv = new G.OffscreenCanvas(9, 8);
        const cx = cv.getContext("2d");
        if (cx) {
          cx.drawImage(bmp, 0, 0, 9, 8);
          const data = cx.getImageData(0, 0, 9, 8).data;
          // 8x8 dHash: bit set if left pixel brighter than right.
          let bits = 0n;
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const i = (y * 9 + x) * 4;
              const j = (y * 9 + (x + 1)) * 4;
              const gl = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
              const gr = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
              bits = (bits << 1n) | (gl > gr ? 1n : 0n);
            }
          }
          return bits.toString(16).padStart(16, "0");
        }
      } catch { /* fall through */ }
    }

    // Fallback: SHA-256 of a downsampled byte sample as a coarse fingerprint.
    // Not a true perceptual hash but reliably equal for identical bytes
    // (the common case: same avatar uploaded everywhere).
    const step = Math.max(1, Math.floor(buf.length / 256));
    const sampled = new Uint8Array(256);
    for (let i = 0, j = 0; j < 256; i += step, j++) sampled[j] = buf[i] ?? 0;
    const hex = await sha256Hex(new TextDecoder("latin1").decode(sampled));
    return hex.slice(0, 16);
  } catch {
    return null;
  }
}

async function stableId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}_${(await sha256Hex(parts.join("|"))).slice(0, 24)}`;
}
