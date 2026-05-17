// Task #3: citation registry.
//
// The agent loop emits citation markers like [E:abc-123] or [W:0] inline in
// assistant text. The registry keeps a stable map from marker → resolved
// payload so the dashboard can render pills without a second LLM call.
//
// Marker kinds:
//   E = entity      F = fact      N = news_item    T = transcript
//   R = relationship M = media    W = web hit (Brave fallback)

export type CitationKind = "E" | "F" | "N" | "T" | "R" | "M" | "W";

export interface CitationPayload {
  kind: CitationKind;
  ref_id: string;
  title: string;
  snippet?: string;
  url?: string;
  timestamp?: string;
}

export interface CitationMarker {
  marker: string;            // e.g. "E:abc-123"
  payload: CitationPayload;
}

export class CitationRegistry {
  private map = new Map<string, CitationPayload>();
  private webIndex = 0;

  register(kind: CitationKind, ref_id: string, payload: Omit<CitationPayload, "kind" | "ref_id">): string {
    const marker = `${kind}:${ref_id}`;
    if (!this.map.has(marker)) {
      this.map.set(marker, { kind, ref_id, ...payload });
    }
    return marker;
  }

  registerWeb(payload: Omit<CitationPayload, "kind" | "ref_id">): string {
    const idx = this.webIndex++;
    return this.register("W", String(idx), payload);
  }

  get(marker: string): CitationPayload | null {
    return this.map.get(marker) ?? null;
  }

  has(marker: string): boolean {
    return this.map.has(marker);
  }

  all(): CitationMarker[] {
    return [...this.map.entries()].map(([marker, payload]) => ({ marker, payload }));
  }

  size(): number { return this.map.size; }

  // Pull every [K:id] marker from a chunk of assistant text. Used by the
  // post-processor to verify every citation pill resolves to a registered
  // row.
  static extractMarkers(text: string): string[] {
    const out: string[] = [];
    const re = /\[([EFNTRMW]):([^\]\s]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(`${m[1]}:${m[2]}`);
    return out;
  }
}
