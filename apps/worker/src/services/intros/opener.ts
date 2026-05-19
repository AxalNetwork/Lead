// Drafts a ≤60-word opener for the asker to send to the first hop.
//
// The opener references one concrete signal from the edge's
// quality_signals_json when available (e.g. "you co-invested in Acme
// in 2023"); otherwise falls back to a generic template. Whichever
// path produces the text, we hard-clamp to 60 words before returning.
//
// If env.OPENAI_API_KEY is present we call the OpenAI chat API for a
// fluent draft; otherwise we deterministically template the opener
// from the structured signals. Both code paths go through the same
// `clampToWords(text, 60)` truncation step so the contract holds
// regardless of which generator fired.

export interface OpenerInputs {
  /** Display name of the operator/asker — appears in the signature line. */
  viewer_name: string | null;
  /** Display name of the first hop (the person the operator is asking). */
  first_hop_name: string | null;
  /** Display name of the ultimate target. */
  target_name: string | null;
  /** The free-text ask context. */
  ask_context: string;
  /** Parsed quality_signals_json for the first-hop edge (any/all keys optional). */
  edge_signals: Record<string, unknown> | null;
}

export interface OpenerEnv {
  OPENAI_API_KEY?: string;
}

const MAX_WORDS = 60;

/** Trim a string to at most `n` words, preserving punctuation on the last word. */
export function clampToWords(s: string, n: number = MAX_WORDS): string {
  if (!s) return "";
  const tokens = s.trim().split(/\s+/);
  if (tokens.length <= n) return tokens.join(" ");
  return tokens.slice(0, n).join(" ");
}

/** Pick the most operator-readable concrete signal we can name in one phrase. */
export function pickSignalPhrase(signals: Record<string, unknown> | null): string | null {
  if (!signals) return null;
  // Order matters: prefer the signals operators recognize fastest.
  const co = (signals as { co_investment_5y?: { value?: number; observed_at?: string | null } }).co_investment_5y;
  if (co && (co.value ?? 0) > 0) {
    return co.observed_at
      ? `you two co-invested as recently as ${co.observed_at.slice(0, 7)}`
      : `you've co-invested together`;
  }
  const boards = (signals as { board_overlap?: { value?: number; observed_at?: string | null } }).board_overlap;
  if (boards && (boards.value ?? 0) > 0) {
    return `you've sat on the same board`;
  }
  const firm = (signals as { same_firm_or_school?: { value?: number } }).same_firm_or_school;
  if (firm && (firm.value ?? 0) > 0) {
    return `you share an alma mater or former firm`;
  }
  const panels = (signals as { joint_panels?: { value?: number } }).joint_panels;
  if (panels && (panels.value ?? 0) > 0) {
    return `you've spoken on a panel together`;
  }
  return null;
}

/** Deterministic template — used when no LLM is configured or the LLM call fails. */
export function templateOpener(inputs: OpenerInputs): string {
  const hop = inputs.first_hop_name || "there";
  const target = inputs.target_name || "the founder";
  const signal = pickSignalPhrase(inputs.edge_signals);
  const ask = (inputs.ask_context || "").trim();
  const askClause = ask ? `I'm reaching out because ${ask.replace(/[.!?]+$/, "").toLowerCase()}.` : "";
  const sigClause = signal ? `Given that ${signal}, I thought you might be a warm intro.` : "";
  const askWho = `Would you be open to a quick intro to ${target}?`;
  const sign = inputs.viewer_name ? `Thanks — ${inputs.viewer_name}` : "Thanks";
  const draft = `Hi ${hop}, ${askClause} ${sigClause} ${askWho} ${sign}`.replace(/\s+/g, " ").trim();
  return clampToWords(draft, MAX_WORDS);
}

/**
 * Generates an opener. Tries the LLM first when configured; falls back
 * to the template on missing key, network error, or any non-2xx
 * response. The returned string is ALWAYS ≤60 words.
 */
export async function draftOpener(env: OpenerEnv, inputs: OpenerInputs): Promise<string> {
  const fallback = templateOpener(inputs);
  if (!env.OPENAI_API_KEY) return fallback;
  try {
    const prompt = buildPrompt(inputs);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 180,
        messages: [
          { role: "system", content: "Draft a concise, warm intro request. ≤60 words. No emoji. No subject line." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const txt = j.choices?.[0]?.message?.content?.trim() ?? "";
    if (!txt) return fallback;
    return clampToWords(txt, MAX_WORDS);
  } catch {
    return fallback;
  }
}

function buildPrompt(i: OpenerInputs): string {
  const hop = i.first_hop_name || "(first hop)";
  const target = i.target_name || "(target)";
  const signal = pickSignalPhrase(i.edge_signals);
  const lines = [
    `You're helping ${i.viewer_name ?? "an operator"} ask ${hop} for an intro to ${target}.`,
    `Ask context: ${i.ask_context || "(no specifics provided)"}.`,
  ];
  if (signal) lines.push(`Shared context to reference: ${signal}.`);
  lines.push(`Draft a 50–60 word message to ${hop} only. Friendly, direct, not salesy.`);
  return lines.join("\n");
}
