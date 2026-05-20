// Task #9: plugin loader. Each plugin exports `run({payload, ctx}) →
// PluginResult`. Unimplemented plugins return `status='unsupported'`
// per the Task #14 honest-degradation pattern — never silent failure.

export interface PluginContext {
  node_id: string;
  /** Optional env-supplied endpoint, e.g. LLM_ENDPOINT, PADDLE_OCR. */
  env: Record<string, string | undefined>;
}

export interface PluginResult {
  status: "completed" | "failed" | "unsupported";
  runtime_ms: number;
  tokens_used?: number;
  result?: unknown;
  error?: string;
}

export interface Plugin {
  run(input: { payload: unknown; ctx: PluginContext }): Promise<PluginResult>;
}

function ms(): number { return Date.now(); }
function unsupported(reason: string): PluginResult {
  return { status: "unsupported", runtime_ms: 0, error: reason };
}

const crawl: Plugin = {
  async run({ payload }) {
    const t0 = ms();
    const p = (payload ?? {}) as { url?: string; headers?: Record<string, string>; method?: string };
    if (!p.url) return { status: "failed", runtime_ms: ms() - t0, error: "missing_url" };
    try {
      const r = await fetch(p.url, { method: p.method ?? "GET", headers: p.headers });
      const text = await r.text();
      return {
        status: "completed",
        runtime_ms: ms() - t0,
        result: { status: r.status, body: text.slice(0, 1024 * 1024) },
      };
    } catch (e) {
      return { status: "failed", runtime_ms: ms() - t0, error: (e as Error).message };
    }
  },
};

const extract_html: Plugin = {
  async run({ payload }) {
    const t0 = ms();
    const p = (payload ?? {}) as { html?: string };
    if (typeof p.html !== "string") return { status: "failed", runtime_ms: ms() - t0, error: "missing_html" };
    const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(p.html);
    const stripped = p.html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      status: "completed",
      runtime_ms: ms() - t0,
      result: { title: titleMatch ? titleMatch[1].trim() : null, text: stripped },
    };
  },
};

const llm_classify: Plugin = {
  async run({ payload, ctx }) {
    const t0 = ms();
    const endpoint = ctx.env.LLM_ENDPOINT;
    if (!endpoint) return unsupported("llm_endpoint_unconfigured");
    const p = (payload ?? {}) as { prompt?: string; max_tokens?: number; model?: string };
    if (!p.prompt) return { status: "failed", runtime_ms: ms() - t0, error: "missing_prompt" };
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model ?? ctx.env.LLM_MODEL ?? "llama3",
          prompt: p.prompt,
          stream: false,
          options: { num_predict: p.max_tokens ?? 256 },
        }),
      });
      const j = (await r.json()) as { response?: string; eval_count?: number };
      return {
        status: "completed",
        runtime_ms: ms() - t0,
        tokens_used: j.eval_count ?? 0,
        result: { text: j.response ?? "" },
      };
    } catch (e) {
      return { status: "failed", runtime_ms: ms() - t0, error: (e as Error).message };
    }
  },
};

const embed_text: Plugin = {
  async run({ payload, ctx }) {
    const t0 = ms();
    const endpoint = ctx.env.EMBED_ENDPOINT;
    if (!endpoint) return unsupported("embed_endpoint_unconfigured");
    const p = (payload ?? {}) as { texts?: string[] };
    if (!Array.isArray(p.texts) || !p.texts.length) {
      return { status: "failed", runtime_ms: ms() - t0, error: "missing_texts" };
    }
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: p.texts }),
      });
      const j = (await r.json()) as { embeddings?: number[][] };
      return {
        status: "completed",
        runtime_ms: ms() - t0,
        tokens_used: p.texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
        result: { embeddings: j.embeddings ?? [] },
      };
    } catch (e) {
      return { status: "failed", runtime_ms: ms() - t0, error: (e as Error).message };
    }
  },
};

const vision_ocr: Plugin = {
  async run({ payload, ctx }) {
    const t0 = ms();
    // Honest path: defers to a local HTTP service that fronts
    // tesseract / PaddleOCR. The CLI shell-out is intentionally NOT
    // attempted here — the SDK does not assume a shell environment.
    const endpoint = ctx.env.OCR_ENDPOINT;
    if (!endpoint) return unsupported("ocr_endpoint_unconfigured");
    const p = (payload ?? {}) as { image_url?: string; image_base64?: string };
    if (!p.image_url && !p.image_base64) {
      return { status: "failed", runtime_ms: ms() - t0, error: "missing_image" };
    }
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const j = (await r.json()) as { text?: string };
      return { status: "completed", runtime_ms: ms() - t0, result: { text: j.text ?? "" } };
    } catch (e) {
      return { status: "failed", runtime_ms: ms() - t0, error: (e as Error).message };
    }
  },
};

const transcribe_audio: Plugin = {
  async run() { return unsupported("transcribe_audio_not_implemented_in_v1"); },
};
const render_browser: Plugin = {
  async run() { return unsupported("render_browser_not_implemented_in_v1"); },
};

export const PLUGINS: Record<string, Plugin> = {
  crawl, extract_html, llm_classify, embed_text, vision_ocr,
  transcribe_audio, render_browser,
};

export function loadPlugin(jobType: string): Plugin | null {
  return PLUGINS[jobType] ?? null;
}
