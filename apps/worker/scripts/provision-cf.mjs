#!/usr/bin/env node
// Local Cloudflare provisioner — mirrors the "Ensure … exist" steps of
// .github/workflows/deploy-worker.yml so a fresh account (or a workstation
// without the GitHub secret) can be brought up to what wrangler.toml
// declares. Idempotent: "already exists" responses are treated as success.
//
//   CLOUDFLARE_API_TOKEN=… node scripts/provision-cf.mjs [--dry-run]
//
// Creates: R2 buckets, Vectorize indexes (dim/metric from the `# dim=N
// metric=M` annotation), Queues, KV namespaces (prints the id to paste into
// wrangler.toml), and the D1 database if its name is missing. Probes the
// Analytics Engine dataset and lists which optional Worker secrets are
// still unset. It never deletes anything and never touches Access.
//
// See docs/cloudflare-operations-checklist.md for the full inventory.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A trailing sentinel table lets every `[[block]]` end on "the next table header".
const TOML = fs.readFileSync(path.resolve(__dirname, "../wrangler.toml"), "utf8") + "\n[__end__]\n";
const DRY = process.argv.includes("--dry-run");
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is required (scopes: see apps/worker/README.md).");
  process.exit(2);
}

const ACCOUNT = /^account_id\s*=\s*"([^"]+)"/m.exec(TOML)?.[1] ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const WORKER = /^name\s*=\s*"([^"]+)"/m.exec(TOML)?.[1] ?? "lead";
if (!ACCOUNT) { console.error("account_id not found in wrangler.toml"); process.exit(2); }
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

// ---- wrangler.toml parsing (same shapes the deploy workflow greps for) ----
function blocks(kind) {
  const out = [];
  const re = new RegExp(`^\\[\\[${kind}\\]\\]\\s*$([\\s\\S]*?)(?=^\\[)`, "gm");
  for (const m of TOML.matchAll(re)) out.push(m[1]);
  return out;
}
const kv = (block, key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(block)?.[1] ?? null;

const r2Buckets = blocks("r2_buckets").map((b) => kv(b, "bucket_name")).filter(Boolean);
const kvTitles = blocks("kv_namespaces").map((b) => ({ binding: kv(b, "binding"), id: kv(b, "id") })).filter((x) => x.binding);
const d1Names = blocks("d1_databases").map((b) => ({ name: kv(b, "database_name"), id: kv(b, "database_id") })).filter((x) => x.name);
const queues = [...new Set(blocks("queues.producers").concat(blocks("queues.consumers")).map((b) => kv(b, "queue")).filter(Boolean))];
const vectorize = blocks("vectorize").map((b) => {
  const line = /^\s*index_name\s*=.*$/m.exec(b)?.[0] ?? "";
  const name = /"([^"]+)"/.exec(line)?.[1];
  const dim = Number(/dim\s*=\s*(\d+)/.exec(line)?.[1] ?? 768);
  const metric = /metric\s*=\s*([A-Za-z_-]+)/.exec(line)?.[1] ?? "cosine";
  return name ? { name, dim, metric } : null;
}).filter(Boolean);
const aeDatasets = blocks("analytics_engine_datasets").map((b) => kv(b, "dataset")).filter(Boolean);

// ---- API helpers ----
async function cf(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}
const codes = (j) => (j?.errors ?? []).map((e) => e.code);
function outcome(label, r, existsCodes) {
  if (r.json?.success) return console.log(`  created ${label}`);
  if (codes(r.json).some((c) => existsCodes.includes(c)) || JSON.stringify(r.json).toLowerCase().includes("already exists")) {
    return console.log(`  ok (exists) ${label}`);
  }
  if (codes(r.json).includes(10000)) throw new Error(`AUTH FAILURE creating ${label}: token is missing a scope (see README).`);
  throw new Error(`unexpected response for ${label}: ${JSON.stringify(r.json)}`);
}
async function ensure(label, exists, create, existsCodes) {
  if (await exists()) return console.log(`  ok (exists) ${label}`);
  if (DRY) return console.log(`  MISSING ${label} (would create)`);
  outcome(label, await create(), existsCodes);
}

async function main() {
  console.log(`Account ${ACCOUNT} · worker "${WORKER}" · ${DRY ? "DRY RUN" : "apply"}`);

  console.log("\nD1");
  const d1Live = (await cf("GET", `${API}/d1/database?per_page=100`)).json?.result ?? [];
  for (const d of d1Names) {
    const live = d1Live.find((x) => x.name === d.name);
    if (live) {
      console.log(`  ok (exists) ${d.name} id=${live.uuid}${live.uuid === d.id ? "" : "  ← DIFFERS from wrangler.toml database_id"}`);
      continue;
    }
    if (DRY) { console.log(`  MISSING ${d.name} (would create)`); continue; }
    const r = await cf("POST", `${API}/d1/database`, { name: d.name });
    if (!r.json?.success) throw new Error(`d1 create failed: ${JSON.stringify(r.json)}`);
    console.log(`  created ${d.name} id=${r.json.result.uuid}\n  ACTION REQUIRED: set database_id = "${r.json.result.uuid}" in wrangler.toml, then run: npx wrangler d1 migrations apply DB --remote`);
  }

  console.log("\nKV namespaces");
  const kvLive = (await cf("GET", `${API}/storage/kv/namespaces?per_page=100`)).json?.result ?? [];
  for (const n of kvTitles) {
    const byId = n.id && kvLive.find((x) => x.id === n.id);
    const byTitle = kvLive.find((x) => x.title === n.binding);
    if (byId) { console.log(`  ok (exists) ${n.binding} id=${n.id}`); continue; }
    if (byTitle) { console.log(`  ok (exists) ${n.binding} id=${byTitle.id}  ← wrangler.toml id (${n.id}) does not match; paste this id`); continue; }
    if (DRY) { console.log(`  MISSING ${n.binding} (would create)`); continue; }
    const r = await cf("POST", `${API}/storage/kv/namespaces`, { title: n.binding });
    outcome(n.binding, r, [10014]);
    if (r.json?.result?.id) console.log(`  ACTION REQUIRED: paste id="${r.json.result.id}" into [[kv_namespaces]] for binding ${n.binding}.`);
  }

  console.log("\nR2 buckets");
  const r2Live = (await cf("GET", `${API}/r2/buckets?per_page=1000`)).json?.result?.buckets?.map((b) => b.name) ?? [];
  for (const b of r2Buckets) await ensure(b, async () => r2Live.includes(b), () => cf("POST", `${API}/r2/buckets`, { name: b }), [10004]);

  console.log("\nQueues");
  const qLive = (await cf("GET", `${API}/queues?per_page=100`)).json?.result?.map((q) => q.queue_name) ?? [];
  for (const q of queues) await ensure(q, async () => qLive.includes(q), () => cf("POST", `${API}/queues`, { queue_name: q }), [11009]);

  console.log("\nVectorize indexes");
  const vLive = (await cf("GET", `${API}/vectorize/v2/indexes`)).json?.result ?? [];
  for (const v of vectorize) {
    const live = vLive.find((x) => x.name === v.name);
    if (live) {
      const dim = live.config?.dimensions, metric = live.config?.metric;
      const drift = (dim && dim !== v.dim) || (metric && metric !== v.metric);
      console.log(`  ok (exists) ${v.name} ${dim}-d ${metric}${drift ? `  ← DRIFT: wrangler.toml says ${v.dim}-d ${v.metric} (fatal in CI)` : ""}`);
      continue;
    }
    await ensure(`${v.name} (${v.dim}-d ${v.metric})`, async () => false,
      () => cf("POST", `${API}/vectorize/v2/indexes`, { name: v.name, config: { dimensions: v.dim, metric: v.metric } }), [3149]);
  }

  console.log("\nAnalytics Engine");
  for (const d of aeDatasets) {
    const r = await fetch(`${API}/analytics_engine/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: `SELECT 1 FROM ${d} LIMIT 1`, signal: AbortSignal.timeout(30_000),
    });
    const txt = await r.text();
    if (r.ok || /table not found|does not exist/i.test(txt)) console.log(`  ok ${d} (${r.ok ? "queryable" : "self-provisions on first write"})`);
    else throw new Error(`AE probe failed for ${d}: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }

  console.log("\nWorker secrets");
  const s = await cf("GET", `${API}/workers/scripts/${WORKER}/secrets`);
  if (!s.json?.success) {
    console.log(`  (worker "${WORKER}" not deployed yet or token lacks Workers Scripts: Read — skipping secret check)`);
  } else {
    const set = new Set(s.json.result.map((x) => x.name));
    const optional = ["FOUNDER_FEEDBACK_SALT", "SLACK_WEBHOOK_URL", "PERSONA_RESCORE_SECRET", "OPENAI_API_KEY", "AGENT_FALLBACK_KEY",
      "CF_IMAGES_ACCOUNT_HASH", "PROXY_URL", "SMARTPROXY_URL", "BRIGHTDATA_URL", "OXYLABS_URL", "SCRAPERAPI_KEY", "SCRAPESTACK_KEY",
      "FEC_API_KEY", "OPENSECRETS_API_KEY", "PROPUBLICA_API_KEY", "CONGRESS_API_KEY", "COURTLISTENER_TOKEN", "PACER_USER", "PACER_PASS",
      "COMPANIES_HOUSE_API_KEY", "NEWS_API_KEY", "NEWSAPI_KEY", "BRAVE_API_KEY"];
    const missing = optional.filter((n) => !set.has(n));
    console.log(`  set: ${[...set].sort().join(", ") || "(none)"}`);
    console.log(`  unset (optional — feature reports 'unconfigured'): ${missing.join(", ") || "(none)"}`);
    if (!set.has("PROXY_URL") && !["SMARTPROXY_URL", "BRIGHTDATA_URL", "OXYLABS_URL", "SCRAPERAPI_KEY", "SCRAPESTACK_KEY"].some((n) => set.has(n))) {
      console.log("  NOTE: no proxy provider configured — url-kind crawl jobs will be skipped with proxy_not_configured.");
    }
  }

  console.log("\nDone. Not covered here (dashboard only): Workers Paid plan, Browser Rendering, Workers AI, Images, Access apps + CORS bypass. See docs/cloudflare-operations-checklist.md.");
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
