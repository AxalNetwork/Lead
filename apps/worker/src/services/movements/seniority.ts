// Task #2: seniority ladder for partner-movement classification.
//
// The differ uses this ranking to tell `promoted` apart from
// `title_change`. Unknown titles get null; comparison against null is
// always a `title_change`, never a promotion (we never invent a
// direction we can't justify).

const LADDER: Array<{ rank: number; patterns: RegExp[] }> = [
  { rank: 10, patterns: [/\bmanaging partner\b/i, /\bsenior managing director\b/i] },
  { rank:  9, patterns: [/\bgeneral partner\b/i, /\bgp\b/i, /\bfounding partner\b/i, /\bmanaging director\b/i] },
  { rank:  8, patterns: [/\bpartner\b/i] },
  { rank:  7, patterns: [/\bvice president\b/i, /\bvp\b/i, /\bprincipal\b/i] },
  { rank:  6, patterns: [/\bsenior associate\b/i] },
  { rank:  5, patterns: [/\bassociate\b/i] },
  { rank:  4, patterns: [/\boperating partner\b/i, /\bventure partner\b/i] },
  { rank:  3, patterns: [/\banalyst\b/i, /\binvestor\b/i] },
];

export function rankTitle(title: string | null | undefined): number | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  for (const row of LADDER) {
    if (row.patterns.some((re) => re.test(t))) return row.rank;
  }
  return null;
}

export function compareTitles(
  before: string | null | undefined,
  after: string | null | undefined,
): "promoted" | "demoted" | "lateral" | "unknown" {
  const a = rankTitle(before);
  const b = rankTitle(after);
  if (a == null || b == null) return "unknown";
  if (b > a) return "promoted";
  if (b < a) return "demoted";
  return "lateral";
}
