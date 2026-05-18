// Task #3: Translation layer.
//
// Wraps Cloudflare Workers AI for non-English filing text. Output
// shape:
//   { original_lang, original_text, english_text }
//
// Contract:
//   * NEVER overwrite original_text — translation is additive.
//   * Predicate extractors run against english_text.
//   * Entity-name binding tries original_text first then english_text
//     (a German manager's legal name is in German; its translated
//     synonym is a fallback only).
//   * When AI binding is absent OR the text is already English, returns
//     the input as english_text and skips the translation call.

import type { Env } from "../../types";

export interface TranslateResult {
  original_lang: string;     // ISO-639-1
  original_text: string;
  english_text: string;
  /** True when translation actually fired (vs. passthrough). */
  translated: boolean;
}

const LANG_HINTS: Array<[RegExp, string]> = [
  [/[\u4e00-\u9fff]/, "zh"],
  [/[\u3040-\u30ff]/, "ja"],
  [/[\uac00-\ud7af]/, "ko"],
  [/[\u0590-\u05ff]/, "he"],
  [/[\u0600-\u06ff]/, "ar"],
  [/[äöüßẞ]|\b(der|die|das|und|nicht|für|über|mit)\b/i, "de"],
  [/[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|une|nous|vous|pour|avec)\b/i, "fr"],
  [/\b(de|el|la|los|las|para|con|por|que|una)\b.*\b(de|el|la|los|las|para|con|por|que|una)\b/i, "es"],
  [/\b(di|il|la|gli|delle|per|con|sono|non)\b.*\b(di|il|la|gli|delle|per|con|sono|non)\b/i, "it"],
  [/[åäöÅÄÖ]|\b(och|inte|för|med|att|på)\b/i, "sv"],
  [/\b(de|het|een|en|niet|voor|met|van|op)\b.*\b(de|het|een|en|niet|voor|met|van|op)\b/i, "nl"],
  [/\b(do|da|para|com|não|que|uma|são)\b.*\b(do|da|para|com|não|que|uma|são)\b/i, "pt"],
];

/** Best-effort language detection — no network, character-set + stopword
 *  heuristics. Returns 'en' on no positive match. */
export function detectLanguage(text: string): string {
  const s = (text || "").slice(0, 4000);
  for (const [re, code] of LANG_HINTS) if (re.test(s)) return code;
  return "en";
}

interface AiRunResult { response?: string; translated_text?: string; text?: string }

/** Translate non-English text to English via Workers AI. When AI is
 *  unavailable or the text is already English, returns passthrough.
 *  Bounded to 4_000 characters per call to keep one filing predictable. */
export async function translateToEnglish(
  env: Env, text: string, langHint?: string | null,
): Promise<TranslateResult> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { original_lang: "en", original_text: "", english_text: "", translated: false };
  }
  const lang = (langHint ?? detectLanguage(trimmed)).toLowerCase().slice(0, 2);
  if (lang === "en" || !env.AI) {
    return { original_lang: lang, original_text: trimmed, english_text: trimmed, translated: false };
  }
  const input = trimmed.slice(0, 4000);
  try {
    const out = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text: input, source_lang: lang, target_lang: "en",
    }) as AiRunResult;
    const english = out.translated_text || out.response || out.text || "";
    if (!english) {
      return { original_lang: lang, original_text: trimmed, english_text: trimmed, translated: false };
    }
    return { original_lang: lang, original_text: trimmed, english_text: english, translated: true };
  } catch (e) {
    console.warn("translate.translateToEnglish failed:", (e as Error).message);
    return { original_lang: lang, original_text: trimmed, english_text: trimmed, translated: false };
  }
}
