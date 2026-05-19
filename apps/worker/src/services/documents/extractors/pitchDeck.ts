// Task #13: Pitch-deck extractor.
//
// v1 is text-only — pulls problem / solution / market / traction / team
// / ask sections from the deck text (vision-grade per-slide parsing is
// a follow-up). Most decks export readable text from PDF/PPTX, and the
// section headings are stable enough across templates to be regex-able.

export const PITCH_DECK_EXTRACTOR_VERSION = "1.0.0";

export interface PitchDeckExtraction {
  company_name: string | null;
  one_liner: string | null;
  problem: string | null;
  solution: string | null;
  market_size_text: string | null;
  tam_usd: number | null;
  traction_text: string | null;
  team_members: string[];
  ask_amount_usd: number | null;
  use_of_funds: string | null;
  warnings: string[];
}

function sectionAfter(text: string, headings: string[], maxChars = 600): string | null {
  for (const h of headings) {
    const re = new RegExp(`(?:^|\\n|\\s)${h}\\s*[:\\n]([\\s\\S]{20,${maxChars}})`, "i");
    const m = re.exec(text);
    if (m) return m[1].trim().split(/\n{2,}/)[0].slice(0, maxChars).trim();
  }
  return null;
}

function parseUsd(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(\d+(?:\.\d+)?)(k|m|mm|b|bn|t)?$/.exec(t);
  if (!m) { const n = Number(t); return Number.isFinite(n) ? Math.round(n) : null; }
  const v = Number(m[1]);
  const mult =
    m[2] === "k" ? 1e3 :
    (m[2] === "m" || m[2] === "mm") ? 1e6 :
    (m[2] === "b" || m[2] === "bn") ? 1e9 :
    m[2] === "t" ? 1e12 : 1;
  return Math.round(v * mult);
}

export function extractPitchDeck(text: string): PitchDeckExtraction {
  const warnings: string[] = [];
  const problem = sectionAfter(text, ["problem", "the problem"]);
  const solution = sectionAfter(text, ["solution", "our solution", "what we do"]);
  const market_size_text = sectionAfter(text, ["market", "market size", "opportunity", "tam"], 400);
  const traction_text = sectionAfter(text, ["traction", "growth", "metrics"], 400);
  const useOfFunds = sectionAfter(text, ["use of funds", "use of proceeds"], 400);

  const tamM = /tam[^$]{0,40}\$\s*([\d,.]+\s*(?:k|m|mm|b|bn|t)?)/i.exec(text);
  const tam_usd = tamM ? parseUsd(tamM[1]) : null;

  const askM = /(?:raising|asking|the\s+ask|seeking)[^$]{0,40}\$\s*([\d,.]+\s*(?:k|m|mm|b|bn)?)/i.exec(text);
  const ask_amount_usd = askM ? parseUsd(askM[1]) : null;

  // Team: capture lines under a "team" heading that look like "Name — Role".
  const teamSection = sectionAfter(text, ["team", "our team", "founders"], 1200);
  const team_members: string[] = [];
  if (teamSection) {
    const lines = teamSection.split(/\n+/);
    for (const line of lines) {
      const m = /^([A-Z][A-Za-z'.\-]+(?:\s+[A-Z][A-Za-z'.\-]+){1,2})\b/.exec(line.trim());
      if (m) team_members.push(m[1]);
      if (team_members.length >= 10) break;
    }
  }

  // Heuristic company + one-liner: first non-empty line + second non-empty line.
  const firstLines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 2).slice(0, 6);
  const company_name = firstLines[0] && firstLines[0].length <= 80 ? firstLines[0] : null;
  const one_liner = firstLines[1] && firstLines[1].length <= 200 ? firstLines[1] : null;

  if (!problem && !solution) warnings.push("no_problem_or_solution_section");
  return {
    company_name, one_liner, problem, solution, market_size_text,
    tam_usd, traction_text, team_members, ask_amount_usd,
    use_of_funds: useOfFunds, warnings,
  };
}
