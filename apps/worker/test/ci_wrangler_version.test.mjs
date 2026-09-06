// CI must run the wrangler this repo declares.
//
// The deploy workflow pinned `wrangler@3.99.0` for the D1 migration steps
// and for cloudflare/wrangler-action, while apps/worker/package.json declares
// ^4.91.0 — three majors apart. Cloudflare Workers Builds, which uses the
// project's own wrangler, deployed the same commits successfully; the GitHub
// Actions deploy failed at `d1 migrations list`, exiting 1 with no error at
// all while the token demonstrably could list the account's D1 databases,
// resolve the declared database_id, and run SQL against it.
//
// `npx --yes wrangler@X` also pins only the CLI, not its dependency tree, so
// a transitive release can change behaviour with no commit here — which is
// what a failure appearing with no corresponding code change looks like.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const WF_DIR = join(REPO, ".github", "workflows");

const declared = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  .devDependencies.wrangler.replace(/^[\^~]/, "");

function workflows() {
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ name: f, body: readFileSync(join(WF_DIR, f), "utf8") }));
}

test("no workflow invokes a hard-pinned wrangler via npx", () => {
  const bad = [];
  for (const { name, body } of workflows()) {
    for (const line of body.split("\n")) {
      // Ignore comments — the fix is explained in them.
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/npx\s+(?:--yes\s+)?wrangler@([\d.]+)/);
      if (m) bad.push(`${name}: wrangler@${m[1]}`);
    }
  }
  assert.deepEqual(bad, [],
    "these workflows pin a wrangler version independently of package.json:\n  " +
    bad.join("\n  ") + "\n\nRun `npx wrangler` after installing dependencies " +
    "so CI uses the version the project is developed and deployed with.");
});

test("wrangler-action's version matches package.json", () => {
  const mismatched = [];
  for (const { name, body } of workflows()) {
    for (const m of body.matchAll(/wranglerVersion:\s*"([\d.]+)"/g)) {
      if (m[1] !== declared) mismatched.push(`${name}: ${m[1]} (package.json declares ${declared})`);
    }
  }
  assert.deepEqual(mismatched, [],
    "wranglerVersion drifted from apps/worker/package.json:\n  " + mismatched.join("\n  "));
});

test("every workflow running npx wrangler installs dependencies first", () => {
  for (const { name, body } of workflows()) {
    if (!/npx\s+wrangler\b/.test(body.replace(/^\s*#.*$/gm, ""))) continue;
    assert.ok(
      /npm ci|npm install/.test(body),
      `${name} runs \`npx wrangler\` without installing dependencies, so it would ` +
      `download whatever is newest instead of the declared version`,
    );
  }
});
