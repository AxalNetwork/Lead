// Task #1: academic_researcher workflow.
//
// Fetches university page, Google Scholar HTML profile, arXiv author
// page, Semantic Scholar, lab page, and startup-involvement search.

import { makeWorkflow, sameOrigin } from "./_shared";
import { PERSON_SCHEMA, type PersonExtract, mapPerson, googleScholarUrl, arxivUrl, semanticScholarUrl } from "./_commonSchemas";
import type { FactCandidate, WorkflowDef } from "./_types";

const ACAD_SCHEMA = {
  ...PERSON_SCHEMA,
  properties: {
    ...PERSON_SCHEMA.properties,
    institution:        { type: "string" },
    department:         { type: "string" },
    research_topics:    { type: "array", items: { type: "string" } },
    h_index:            { type: "number" },
    citations_total:    { type: "number" },
    lab_website:        { type: "string" },
    google_scholar_url: { type: "string" },
    arxiv_url:          { type: "string" },
    startup_involvement: { type: "array", items: { type: "string" } },
  },
} as const;

interface AcadExtract extends PersonExtract {
  institution?: string;
  department?: string;
  research_topics?: string[];
  h_index?: number;
  citations_total?: number;
  lab_website?: string;
  google_scholar_url?: string;
  arxiv_url?: string;
  startup_involvement?: string[];
}

const def: WorkflowDef = {
  id: "academic_researcher.v1",
  profile_type_id: "academic_researcher",
  estimated_cost_per_run: { sources: 5, ai_neurons: 0.5 },
  plan: (ctx) => [
    ...sameOrigin(ctx.candidateUrl, ["/people", "/faculty", "/research"]),
    googleScholarUrl(ctx),
    arxivUrl(ctx),
    semanticScholarUrl(ctx),
  ],
  extractionSchema: ACAD_SCHEMA as unknown as Record<string, unknown>,
  systemPrompt:
    "Extract facts about an academic researcher from their faculty page, " +
    "Google Scholar profile, arXiv author page, or Semantic Scholar. " +
    "research_topics are lowercase tags. startup_involvement lists " +
    "companies the researcher has co-founded, advised, or licensed " +
    "technology to. Reply strict JSON matching the schema.",
  map: ({ aiJson, source }) => {
    const j = aiJson as AcadExtract;
    const out: FactCandidate[] = mapPerson(j, source, "academic");
    const conf = Math.min(0.95, Math.max(0.3, Number(j?.confidence ?? 0.7)));
    const str = (pred: string, v: unknown) => {
      if (typeof v === "string" && v.trim()) {
        out.push({ predicate: pred, valueText: v.trim(), sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    const num = (pred: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push({ predicate: pred, valueNumber: v, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    const arr = (pred: string, v: unknown) => {
      if (Array.isArray(v)) {
        const n = v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
        if (n.length) out.push({ predicate: pred, valueJson: n, sourceUrl: source.url, sourceTag: source.tag, confidence: conf });
      }
    };
    str("academic.institution",        j.institution);
    str("academic.department",         j.department);
    str("academic.lab_website",        j.lab_website);
    str("academic.google_scholar_url", j.google_scholar_url);
    str("academic.arxiv_url",          j.arxiv_url);
    num("academic.h_index",            j.h_index);
    num("academic.citations_total",    j.citations_total);
    arr("academic.research_topics",    j.research_topics);
    arr("academic.startup_involvement", j.startup_involvement);
    return out;
  },
};

export const academicResearcherWorkflow = makeWorkflow(def);
