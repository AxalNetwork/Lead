// Shared helpers for individual pivots.

export interface SimpleFetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
}

// Lightweight direct fetch (no tier escalation) tailored for OSINT probes.
// We deliberately skip the heavyweight scraper pipeline because most probes
// are JSON APIs or short profile HTML — full tier escalation is overkill.
//
// Honors a hard timeout via AbortController; bubbles network errors as
// { ok: false }. Caller is responsible for negative-cache writes.
export async function simpleGet(
  url: string,
  opts: { timeoutMs?: number; accept?: string; ua?: string } = {},
): Promise<SimpleFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": opts.ua ?? "AIDataSignal-OSINT/1.0 (+https://aidatasignal.com)",
        "Accept": opts.accept ?? "text/html,application/json;q=0.9,*/*;q=0.1",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") ?? "";
    let text = "";
    // Cap body at 256 KiB — profile pages are well under this.
    const reader = res.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); total += value.length; if (total > 262144) break; }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      text = new TextDecoder("utf-8").decode(merged);
    }
    return { ok: res.ok, status: res.status, text, contentType: ct };
  } catch (e) {
    return { ok: false, status: 0, text: (e as Error).message, contentType: "" };
  } finally {
    clearTimeout(t);
  }
}

// Concurrency-limited Promise.all.
export async function parallelMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Time gate — quick check before launching a sub-probe.
export function pastDeadline(deadlineMs: number): boolean {
  return Date.now() > deadlineMs;
}

// Best-effort log without throwing.
export function safeLog(label: string, info: Record<string, unknown>): void {
  try { console.log(`osint:${label}`, JSON.stringify(info)); } catch { /* ignore */ }
}

// True when a 200-OK body contains a known not-found marker.
export function bodyLooksLikeMiss(text: string, hints: string[]): boolean {
  if (!text || !hints.length) return false;
  const low = text.toLowerCase();
  return hints.some((h) => low.includes(h.toLowerCase()));
}

// Generate plausible handle candidates from a display name and known handles.
export function generateHandleVariants(facts: { displayName: string | null; emails: string[]; knownHandles: Array<{ handle: string }>; }): string[] {
  const out = new Set<string>();
  for (const h of facts.knownHandles) {
    if (h.handle) out.add(h.handle.toLowerCase());
  }
  if (facts.displayName) {
    const norm = facts.displayName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const parts = norm.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0].replace(/[^a-z0-9]/g, "");
      const last = parts[parts.length - 1].replace(/[^a-z0-9]/g, "");
      if (first && last) {
        out.add(`${first}${last}`);
        out.add(`${first}.${last}`);
        out.add(`${first}_${last}`);
        out.add(`${first}-${last}`);
        out.add(`${first[0]}${last}`);
        out.add(`${first}${last[0]}`);
      }
    } else if (parts[0]) {
      out.add(parts[0].replace(/[^a-z0-9]/g, ""));
    }
  }
  for (const email of facts.emails) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local) out.add(local.replace(/[^a-z0-9._-]/g, ""));
  }
  return [...out].filter((s) => s.length >= 2 && s.length <= 40);
}
