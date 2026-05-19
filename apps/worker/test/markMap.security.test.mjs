// Task #9 frontend security regression: ensures the Mark Map UI
// (apps/site/assets/js/mark-map-tab.js) only allows safe URL schemes
// and uses DOM construction APIs (textContent / createElement /
// setAttribute) rather than HTML string concatenation for any
// attacker-influenced field (holder_name_raw, company_name, ticker,
// panel_name, notes, source_url). This is a source-introspection test
// (no DOM env required).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, "../../../apps/site/assets/js/mark-map-tab.js"), "utf8");

test("mark-map-tab uses DOM APIs, not innerHTML string concat", () => {
  // Only two innerHTML assignments are allowed: clearing the root.
  // Every actual rendering goes through el()/svgEl()/appendChild.
  // Match each innerHTML assignment with its RHS. Only `""` (empty
  // string clear) is permitted.
  const re = /\.innerHTML\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rhs = m[1].trim();
    assert.equal(rhs, '""', "Only innerHTML='' clears are allowed (found: " + rhs + ")");
  }
});

test("mark-map-tab safeHref rejects javascript:/data: and accepts http(s)/mailto", () => {
  // Extract and evaluate safeHref by running the IIFE in a sandbox
  // with a minimal window+document shim.
  const sandbox = {
    window: {},
    document: {
      createElement: () => ({ setAttribute() {}, appendChild() {}, set textContent(_v) {} }),
      createElementNS: () => ({ setAttribute() {}, appendChild() {}, set textContent(_v) {} }),
      createTextNode: () => ({}),
      createDocumentFragment: () => ({ appendChild() {} }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const safeHref = sandbox.window.ADS.MarkMap._safeHref;
  assert.equal(safeHref("https://example.com/x"), "https://example.com/x");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("JAVASCRIPT:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeHref(""), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref("  /relative/path"), null);
});
