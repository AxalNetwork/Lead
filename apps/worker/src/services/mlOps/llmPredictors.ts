// Task #8 — production-eval predictors.
//
// These predictors execute the SAME prompt + model path the worker
// uses in production: each looks up the active prompt via
// `getPrompt(env, key)` from the `prompt_versions` registry, calls
// the configured LLM (OpenAI), and returns the parsed result. They
// are the runtime evaluated by `POST /api/ml/eval/run` when called
// with `mode: "production"`.
//
// Honest degradation (Task #14 PACER pattern, ratified in replit.md):
//  - When `OPENAI_API_KEY` is absent OR the prompt registry has no
//    active row for the prompt_key, the predictor returns
//    `{ unconfigured: true, reason: <code> }`. The runner stamps the
//    whole eval_run as `status='unconfigured'` rather than scoring a
//    fake metric.
//  - When a single LLM call throws / 4xx-5xx / returns non-JSON, that
//    SINGLE example is recorded with `predicted: null` so the metric
//    helpers count it as a miss; the run itself proceeds (one bad
//    completion shouldn't void the run).
//
// Coverage map (prompt_key → task_key):
//   deal_extractor.v1         → deal_extraction
//   page_classifier.v1        → page_classification
//   founder_background.v1     → founder_background
//
// Tasks without a deployed LLM call site today (csv_mapping,
// role_inference, entity_dedupe) still have heuristic-only coverage
// in `predictors.ts`; their production-mode predictor returns
// `unconfigured` with reason `no_llm_call_site_for_task` so the dash
// surfaces the gap explicitly. Follow-up #10 tracks migrating the
// remaining LLM call sites onto getPrompt.

import type { Env } from "../../types";
import type { Predictor, PredictResult, TaskKey } from "./runner";
import { getPrompt } from "./prompts";

// OPENAI_API_KEY is not declared on the Env interface today (other
// modules read it via a similar cast). Narrow the lookup here so we
// don't have to widen the global Env type just for this predictor.
function readOpenAiKey(env: Env): string {
  return (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY ?? "";
}

// Prompt-key naming MUST match the runtime call sites exactly so that
// production-mode eval looks up the same prompt_versions row the live
// extractor uses. Runtime convention is the colon form:
//   - apps/worker/src/ai/dealExtractor.ts    DEAL_EXTRACTOR_PROMPT_KEY = "deal_extractor:v1"
//   - apps/worker/src/services/pageClassifier.ts PAGE_CLASS_PROMPT_KEY = "page_classifier:v1"
// founder_background has no live LLM call site that registers a key
// yet (profileFiller accepts an optional promptKey but no caller
// passes one); the colon form "founder_background:v1" is the
// convention reserved for the upcoming call-site migration tracked
// by follow-up #10. Until that lands, production-mode eval for
// founder_background will return `unconfigured` with reason
// `prompt_not_registered:founder_background:v1`.
const PROMPT_KEY_FOR_TASK: Partial<Record<TaskKey, string>> = {
  deal_extraction: "deal_extractor:v1",
  page_classification: "page_classifier:v1",
  founder_background: "founder_background:v1",
};

export function llmPredictorFor(env: Env, task: TaskKey): Predictor {
  const promptKey = PROMPT_KEY_FOR_TASK[task];
  if (!promptKey) {
    return async () => ({ predicted: null, unconfigured: true, reason: "no_llm_call_site_for_task" });
  }
  const apiKey = readOpenAiKey(env);
  if (!apiKey) {
    return async () => ({ predicted: null, unconfigured: true, reason: "openai_api_key_missing" });
  }
  return async (input, _key): Promise<PredictResult> => {
    const prompt = await getPrompt(env, promptKey);
    if (!prompt) {
      return { predicted: null, unconfigured: true, reason: `prompt_not_registered:${promptKey}` };
    }
    const model = prompt.model_hint || "gpt-4o-mini";
    const system = prompt.body;
    const user = JSON.stringify(input);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) {
        return { predicted: null };
      }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = j.choices?.[0]?.message?.content ?? "";
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      return { predicted: parsed };
    } catch {
      return { predicted: null };
    }
  };
}
