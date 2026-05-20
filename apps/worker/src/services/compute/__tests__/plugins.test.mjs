// Task #9: SDK plugin-loader smoke test.
// Imports the SDK directly via relative path — same source tree.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugin, PLUGINS } from "../../../../../../packages/worker-runner/src/plugins.ts";

test("loadPlugin returns null for unknown job type", () => {
  assert.equal(loadPlugin("does_not_exist"), null);
});

test("transcribe_audio + render_browser ship as unsupported", async () => {
  const t = await PLUGINS.transcribe_audio.run({ payload: {}, ctx: { node_id: "x", env: {} } });
  assert.equal(t.status, "unsupported");
  const b = await PLUGINS.render_browser.run({ payload: {}, ctx: { node_id: "x", env: {} } });
  assert.equal(b.status, "unsupported");
});

test("llm_classify reports unsupported when LLM_ENDPOINT unset", async () => {
  const r = await PLUGINS.llm_classify.run({
    payload: { prompt: "hi" },
    ctx: { node_id: "x", env: {} },
  });
  assert.equal(r.status, "unsupported");
  assert.equal(r.error, "llm_endpoint_unconfigured");
});

test("extract_html strips tags and returns title", async () => {
  const r = await PLUGINS.extract_html.run({
    payload: { html: "<html><head><title>Hi</title></head><body><p>One <b>two</b></p><script>alert(1)</script></body></html>" },
    ctx: { node_id: "x", env: {} },
  });
  assert.equal(r.status, "completed");
  assert.equal(r.result.title, "Hi");
  assert.match(r.result.text, /One two/);
});
