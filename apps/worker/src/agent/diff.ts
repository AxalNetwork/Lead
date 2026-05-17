// Task #3: structured diff between two answers of the same saved-research
// question. The nightly refresh produces a fresh answer + citations, and
// the dashboard renders the diff above the answer as "X changed since you
// last asked".
//
// We diff at the citation level (entity-level adds/removes + new news pills
// + new fact pills). Score deltas are surfaced when both runs cited the
// same entity_summary row and its fit_max_score / intent_score changed.

import type { CitationMarker } from "./registry";

export interface ResearchDiff {
  added_entities: Array<{ id: string; title: string }>;
  removed_entities: Array<{ id: string; title: string }>;
  new_news: Array<{ id: string; title: string; url?: string }>;
  new_facts: Array<{ id: string; title: string }>;
  score_deltas: Array<{ entity_id: string; field: string; before: number; after: number }>;
  total_changes: number;
}

function byKind(cites: CitationMarker[], kind: string): CitationMarker[] {
  return cites.filter((c) => c.payload.kind === kind);
}

export function diffAnswers(
  before: { citations: CitationMarker[]; scores?: Record<string, Record<string, number>> },
  after: { citations: CitationMarker[]; scores?: Record<string, Record<string, number>> },
): ResearchDiff {
  const beforeEntities = new Map(byKind(before.citations, "E").map((c) => [c.payload.ref_id, c.payload.title]));
  const afterEntities  = new Map(byKind(after.citations,  "E").map((c) => [c.payload.ref_id, c.payload.title]));
  const beforeNews = new Set(byKind(before.citations, "N").map((c) => c.payload.ref_id));
  const beforeFacts = new Set(byKind(before.citations, "F").map((c) => c.payload.ref_id));

  const added_entities: Array<{ id: string; title: string }> = [];
  for (const [id, title] of afterEntities) {
    if (!beforeEntities.has(id)) added_entities.push({ id, title });
  }
  const removed_entities: Array<{ id: string; title: string }> = [];
  for (const [id, title] of beforeEntities) {
    if (!afterEntities.has(id)) removed_entities.push({ id, title });
  }
  const new_news = byKind(after.citations, "N")
    .filter((c) => !beforeNews.has(c.payload.ref_id))
    .map((c) => ({ id: c.payload.ref_id, title: c.payload.title, url: c.payload.url }));
  const new_facts = byKind(after.citations, "F")
    .filter((c) => !beforeFacts.has(c.payload.ref_id))
    .map((c) => ({ id: c.payload.ref_id, title: c.payload.title }));

  const score_deltas: ResearchDiff["score_deltas"] = [];
  if (before.scores && after.scores) {
    for (const eid of Object.keys(after.scores)) {
      const a = after.scores[eid] ?? {};
      const b = before.scores[eid] ?? {};
      for (const field of Object.keys(a)) {
        if (typeof a[field] === "number" && typeof b[field] === "number" && a[field] !== b[field]) {
          score_deltas.push({ entity_id: eid, field, before: b[field], after: a[field] });
        }
      }
    }
  }

  const total = added_entities.length + removed_entities.length + new_news.length + new_facts.length + score_deltas.length;
  return { added_entities, removed_entities, new_news, new_facts, score_deltas, total_changes: total };
}
