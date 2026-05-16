// Task #3: risk + trust scoring.
//
// Given the set of OPEN/CONFIRMED findings for an entity, produce:
//   risk_score   0..100 (higher = riskier)
//   trust_score  0..100 (higher = more trustworthy)
//   risk_band    low | medium | high | critical
//   components   {sanctions, pep, adverse_media, court_case, enforcement, green_flag}
//
// Severity multipliers and per-category caps keep one outsized signal
// from saturating the score and let positive signals (green flags)
// claw back some trust. Numbers are deliberately conservative — the
// spec treats this as advisory; reviewer judgment is final.

export interface FindingForScore {
  finding_type: string;
  severity: string;
  status: string;
  match_score?: number | null;
}

export interface ScoreResult {
  risk_score: number;
  trust_score: number;
  risk_band: "low" | "medium" | "high" | "critical" | "unknown";
  components: {
    sanctions: number;
    pep: number;
    adverse_media: number;
    court_case: number;
    enforcement: number;
    disqualified_director: number;
    green_flag: number;
  };
  counts: {
    sanctions_count: number;
    pep_count: number;
    adverse_media_count: number;
    court_case_count: number;
    enforcement_count: number;
    green_flag_count: number;
  };
}

const SEVERITY_MULT: Record<string, number> = {
  low: 0.5,
  medium: 1.0,
  high: 1.6,
  critical: 2.2,
};

// Per-category base contribution per (confirmed) finding, capped at the
// category ceiling.
const CATEGORY: Record<string, { per: number; cap: number; trust_drag: number }> = {
  sanction:              { per: 35, cap: 60, trust_drag: 40 },
  pep:                   { per: 8,  cap: 20, trust_drag: 5 },
  adverse_media:         { per: 4,  cap: 25, trust_drag: 8 },
  court_case:            { per: 6,  cap: 20, trust_drag: 6 },
  enforcement:           { per: 18, cap: 35, trust_drag: 25 },
  disqualified_director: { per: 22, cap: 30, trust_drag: 25 },
};

const GREEN_FLAG_PER = 4;
const GREEN_FLAG_CAP = 20;

function band(score: number): ScoreResult["risk_band"] {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function computeScores(findings: FindingForScore[]): ScoreResult {
  const cat: ScoreResult["components"] = {
    sanctions: 0, pep: 0, adverse_media: 0, court_case: 0, enforcement: 0,
    disqualified_director: 0, green_flag: 0,
  };
  const counts: ScoreResult["counts"] = {
    sanctions_count: 0, pep_count: 0, adverse_media_count: 0,
    court_case_count: 0, enforcement_count: 0, green_flag_count: 0,
  };

  let trust_drag = 0;
  let green_lift = 0;

  for (const f of findings) {
    if (f.status !== "open" && f.status !== "confirmed") continue;
    const sev = SEVERITY_MULT[f.severity] ?? 1.0;
    const matchWeight = typeof f.match_score === "number" ? Math.max(0.3, f.match_score) : 1;

    if (f.finding_type === "green_flag") {
      cat.green_flag = Math.min(GREEN_FLAG_CAP, cat.green_flag + GREEN_FLAG_PER * sev);
      green_lift += GREEN_FLAG_PER * sev;
      counts.green_flag_count += 1;
      continue;
    }

    const def = CATEGORY[f.finding_type];
    if (!def) continue;
    const contrib = def.per * sev * matchWeight;
    const keyMap: Record<string, keyof ScoreResult["components"]> = {
      sanction: "sanctions",
      pep: "pep",
      adverse_media: "adverse_media",
      court_case: "court_case",
      enforcement: "enforcement",
      disqualified_director: "disqualified_director",
    };
    const k = keyMap[f.finding_type];
    if (k) cat[k] = Math.min(def.cap, cat[k] + contrib);
    trust_drag += def.trust_drag * sev * matchWeight;

    if (f.finding_type === "sanction") counts.sanctions_count += 1;
    else if (f.finding_type === "pep") counts.pep_count += 1;
    else if (f.finding_type === "adverse_media") counts.adverse_media_count += 1;
    else if (f.finding_type === "court_case") counts.court_case_count += 1;
    else if (f.finding_type === "enforcement") counts.enforcement_count += 1;
  }

  const rawRisk = cat.sanctions + cat.pep + cat.adverse_media + cat.court_case + cat.enforcement + cat.disqualified_director - 0.5 * cat.green_flag;
  const risk_score = Math.max(0, Math.min(100, Math.round(rawRisk * 10) / 10));

  // Trust starts at 65 (slightly-positive default for a clean entity)
  // and is dragged down by negatives, lifted by green flags. Capped at
  // [0,100]. Baseline >60 ensures no-match entities clear the spec's
  // "trust_score > 60 for clean entities" acceptance bar before any
  // green-flag enrichment has run.
  const trustRaw = 65 - Math.min(80, trust_drag) + Math.min(35, green_lift);
  const trust_score = Math.max(0, Math.min(100, Math.round(trustRaw * 10) / 10));

  return {
    risk_score,
    trust_score,
    risk_band: band(risk_score),
    components: cat,
    counts,
  };
}
