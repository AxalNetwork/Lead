# @axal/worker-runner

External compute runner for the AI Data Signal worker pool
(Task #9). Long-polls the orchestrator for jobs, executes them via
per-job-type plugin modules, and posts results back over signed HTTPS
envelopes (HMAC-SHA256).

## Install + run

```bash
# Operator pastes name + provider into /ops/compute-nodes/, copies
# the one-line command, runs it on the external box.
npx @axal/worker-runner --token=<registration_token>
```

The runner exchanges the short-lived registration token for the
long-lived HMAC secret on first call, stores it in
`~/.axal/worker.json` (mode 0600 — never logged), and starts the
heartbeat + pull loop.

## Plugins

Ships:

| Plugin           | Status        | Notes                                      |
|------------------|---------------|--------------------------------------------|
| `crawl`          | implemented   | HTTP GET with proxy/headers passthrough    |
| `extract_html`   | implemented   | tag-stripped text + meta extraction        |
| `llm_classify`   | implemented   | local Ollama/vLLM via `LLM_ENDPOINT`       |
| `embed_text`     | implemented   | sentence-transformers CLI                  |
| `vision_ocr`     | implemented   | tesseract (PaddleOCR if `PADDLE_OCR=1`)    |
| `transcribe_audio` | **unsupported** | reports cleanly per Task #14 honest-degradation |
| `render_browser` | **unsupported** | reports cleanly per Task #14 honest-degradation |

Unsupported plugins POST back `status='unsupported'` so the
dispatcher routes elsewhere or falls back — no silent failures.

## Envelope

Every request to the orchestrator carries an `X-Compute-Envelope`
header:

```json
{
  "node_id": "node_…",
  "timestamp": 1737313200000,
  "nonce": "uuid",
  "body_sha256": "…",
  "signature": "hex HMAC-SHA256(node_id|ts|nonce|body_sha256)"
}
```

Both sides reject envelopes older than 60s and reused nonces (60s
rolling cache on the worker side).
