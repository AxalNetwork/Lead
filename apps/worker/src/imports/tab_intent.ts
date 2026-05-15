// Classify a parsed tab/sheet by intent so import.ts can route it to the
// right destination table:
//
//   firms          → upsert into firms (the default for List/Investors/Funds tabs)
//   firm_metrics   → time-series rows in firm_metrics (Monthly/Yearly/Stats by year)
//   firm_geo       → geo-allocation rows (Geos tab) → firm_metrics (metric=geo_pct)
//   firm_kpi       → snapshot KPIs (Stats tab) → firm_metrics (metric=value, period=YTD)
//   notes          → ignore (free-text "About"/"Methodology" tabs)
//   discard        → e.g. "Sources", "Changelog"
//
// Returns intent + confidence + optional subkind (e.g. 'gov_fund' steers
// firms.kind on subsequent upsert).

export type TabIntent = "firms" | "firm_metrics" | "firm_geo" | "firm_kpi" | "leads" | "notes" | "discard";

export interface TabClassification {
  intent: TabIntent;
  confidence: number;
  subkind?: string;
}

interface Rule {
  intent: TabIntent;
  conf: number;
  subkind?: string;
  name?: RegExp;
  header?: RegExp;
  /** Require AT LEAST this many header matches (for header-based rules). */
  minHeader?: number;
}

const RULES: Rule[] = [
  // README / instructions / signup tabs → notes (preserved as free text,
  // not imported as data).
  { intent: "notes", conf: 0.95,
    name: /^(read\s*me|read|readme|instructions?|how\s*to|getting\s*started|signup|sign[\s_-]*up|register|tos|terms|privacy|disclaimer|intro|introduction|welcome|cover\s*page?)$/i },
  // Sources / changelog / methodology → discard.
  { intent: "discard", conf: 0.95, name: /^(sources?|changelog|methodology|legend|notes?|about)$/i },
  // People / contacts / leads tabs.
  { intent: "leads", conf: 0.92,
    name: /\b(leads?|contacts?|people|persons?|team|partners?|members?|staff|roster|directory\s*\(people\))\b/i },
  // Government/public funds list → firms with kind='gov_fund'.
  { intent: "firms", conf: 0.92, subkind: "gov_fund",
    name: /\b(govt?|government|public|state|sovereign|public\s*funds?|sovereign\s*wealth|swf)\b/i },
  // Geo allocation tabs.
  { intent: "firm_geo", conf: 0.92,
    name: /\b(geo|geograph|countr|region|markets?|by\s*country|by\s*region)\b/i },
  // Time-series / monthly / yearly tabs.
  { intent: "firm_metrics", conf: 0.90,
    name: /\b(monthly|month|yearly|year|quarter|quarterly|by\s*year|by\s*month|by\s*quarter|time\s*series|over\s*time|trend|cohort)\b/i },
  // Stats / KPI snapshot tabs.
  { intent: "firm_kpi", conf: 0.88,
    name: /\b(stats?|kpis?|metrics?|summary|aggregate|totals?|overview)\b/i },
  // List / investor / fund / firm tabs → firms.
  { intent: "firms", conf: 0.92,
    name: /\b(list|investors?|funds?|firms?|vcs?|gps?|vehicles?|managers?|directory|database|all)\b/i },
];

/** Classify a tab. `headers` is used as a fallback when the sheet name is
 *  ambiguous (e.g. "Sheet1"). */
export function classifyTab(sheetName: string | null | undefined, headers: string[] = []): TabClassification {
  const name = (sheetName || "").trim();
  // Name-based rules.
  for (const r of RULES) {
    if (r.name && r.name.test(name)) return { intent: r.intent, confidence: r.conf, subkind: r.subkind };
  }
  // Header-based fallback.
  const hjoined = headers.join(" ").toLowerCase();
  if (/\bemail\b/.test(hjoined) && /\b(name|first\s*name|last\s*name|title|role|person)\b/.test(hjoined)
      && !/\b(firm|fund|investor)\b/.test(hjoined)) {
    return { intent: "leads", confidence: 0.78 };
  }
  if (/\b(year|month|quarter)\b/.test(hjoined) && /\b(deal|invest|exit|fund|aum|raise)/.test(hjoined)) {
    return { intent: "firm_metrics", confidence: 0.7 };
  }
  if (/\b(country|region|geo)\b/.test(hjoined) && /\b(%|share|pct|count|n\b)/.test(hjoined)) {
    return { intent: "firm_geo", confidence: 0.7 };
  }
  if (/\b(firm|fund|investor|name|website|url)\b/.test(hjoined) &&
      /\b(stage|sector|geo|check|aum|founded|hq|country|city)/.test(hjoined)) {
    return { intent: "firms", confidence: 0.78 };
  }
  // Low-row prose fallback: a tab with very few headers (≤2) and any
  // header looking like prose ("description", "text", "instructions") →
  // notes, since data tabs almost always carry ≥3 columns.
  if (headers.length <= 2 && /\b(description|text|instructions?|notes?|content|paragraph|details?)\b/.test(hjoined)) {
    return { intent: "notes", confidence: 0.7 };
  }
  // Default: assume firms with low confidence so the operator can correct.
  return { intent: "firms", confidence: 0.4 };
}
