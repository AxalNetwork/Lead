export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function canonicalize(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = payload[k];
  return JSON.stringify(sorted);
}

export function monthsBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const pa = parseLoose(a);
  const pb = parseLoose(b);
  if (!pa || !pb) return null;
  return Math.max(0, Math.round((pb.getTime() - pa.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
}

function parseLoose(s: string): Date | null {
  // Accepts YYYY, YYYY-MM, YYYY-MM-DD, ISO datetime.
  if (/^\d{4}$/.test(s)) return new Date(`${s}-01-01T00:00:00Z`);
  if (/^\d{4}-\d{2}$/.test(s)) return new Date(`${s}-01T00:00:00Z`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function overlapMonths(
  aStart: string | null | undefined, aEnd: string | null | undefined,
  bStart: string | null | undefined, bEnd: string | null | undefined,
): number | null {
  const as = aStart ? parseLoose(aStart) : null;
  const ae = aEnd ? parseLoose(aEnd) : new Date();
  const bs = bStart ? parseLoose(bStart) : null;
  const be = bEnd ? parseLoose(bEnd) : new Date();
  if (!as || !bs) return null;
  const start = as.getTime() > bs.getTime() ? as : bs;
  const end = (ae?.getTime() ?? Date.now()) < (be?.getTime() ?? Date.now()) ? ae! : be!;
  if (end.getTime() < start.getTime()) return 0;
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
}
