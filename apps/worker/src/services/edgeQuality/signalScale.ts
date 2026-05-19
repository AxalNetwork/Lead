// Pure scoring helpers extracted from signals.ts so they can be
// unit-tested without a D1 stub. The DB-bound collectors in
// signals.ts wrap these helpers around their query results.

/** Log-normalize a non-negative count to [0,1] with knee at `knee`. */
export function logScale(count: number, knee: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(knee) || knee <= 0) return 0;
  return Math.min(1, Math.log1p(count) / Math.log1p(knee));
}

export function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function monthsBetween(a: string, b: string): number {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.max(0, (t2 - t1) / (30.44 * 24 * 3600 * 1000));
}

/**
 * Jaccard similarity over two sets of neighbor ids. Returns 0 when
 * both sets are empty or their union is empty. Excludes the two
 * endpoints themselves so the edge under scoring doesn't contribute
 * to its own "mutual neighbors" count.
 */
export function jaccardNeighbors(
  aNeighbors: Iterable<string>,
  bNeighbors: Iterable<string>,
  excludeIds: ReadonlySet<string>,
): number {
  const A = new Set<string>();
  for (const n of aNeighbors) if (n && !excludeIds.has(n)) A.add(n);
  const B = new Set<string>();
  for (const n of bNeighbors) if (n && !excludeIds.has(n)) B.add(n);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/**
 * Compute board-seat time-overlap in months from two start/end
 * pairs. Open-ended end-dates are treated as `now`. Returns 0
 * when the windows don't overlap or either start is missing.
 */
export function boardOverlapMonths(
  s1: string | null,
  e1: string | null,
  s2: string | null,
  e2: string | null,
  now: string = new Date().toISOString(),
): number {
  const start = maxDate(s1, s2);
  const end = minDate(e1 ?? now, e2 ?? now);
  if (!start || !end) return 0;
  return monthsBetween(start, end);
}
