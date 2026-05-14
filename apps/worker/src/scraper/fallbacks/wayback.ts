/**
 * Wayback Machine fallback. When all live tiers fail, try the most recent
 * archived snapshot via the public CDX availability API. Free, no auth.
 */

interface WaybackHit {
  url: string;
  timestamp: string;
}

export async function findWaybackSnapshot(target: string): Promise<WaybackHit | null> {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`;
  try {
    const res = await fetch(api, {
      headers: { "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
    };
    const closest = json.archived_snapshots?.closest;
    if (!closest?.available || !closest.url) return null;
    return { url: closest.url, timestamp: closest.timestamp ?? "" };
  } catch {
    return null;
  }
}

export async function fetchWaybackHtml(target: string): Promise<{ url: string; html: string } | null> {
  const hit = await findWaybackSnapshot(target);
  if (!hit) return null;
  try {
    const res = await fetch(hit.url, {
      headers: { "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.length < 1024) return null;
    return { url: hit.url, html };
  } catch {
    return null;
  }
}
