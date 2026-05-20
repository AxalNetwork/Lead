#!/usr/bin/env node
// Task #8: Local eval gate. Runs heuristic predictors over the bundled
// gold-set JSON fixtures and asserts that per-task macro-F1 (or
// pair-F1, or field-F1) hasn't regressed more than 5% vs the baseline
// committed at scripts/eval-baseline.json.
//
// This validates the CANDIDATE COMMIT before deploy — unlike the
// remote /api/ml/eval/gate path which queries the deployed worker.
// CI runs this first; the remote gate runs after the deploy as a
// belt-and-suspenders production sanity check.
//
// Bypass with EVAL_LOCAL_SKIP=1 for emergency deploys (logs loud).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.EVAL_LOCAL_SKIP === "1") {
  console.warn("eval-local: EVAL_LOCAL_SKIP=1 — bypassing local eval gate.");
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = join(__dirname, "../src/services/mlOps/goldDatasets");
const BASELINE_PATH = join(__dirname, "eval-baseline.json");
const UPDATE = process.env.EVAL_LOCAL_UPDATE === "1";
const THRESHOLD_PCT = Number(process.env.EVAL_LOCAL_THRESHOLD ?? 5);

// ---- Pure metric helpers (mirror services/mlOps/metrics.ts) ----
function classificationF1(pairs) {
  const labels = new Set();
  for (const p of pairs) { labels.add(p.gold); labels.add(p.pred); }
  let f1Sum = 0; let n = 0;
  for (const l of labels) {
    const tp = pairs.filter((p) => p.pred === l && p.gold === l).length;
    const fp = pairs.filter((p) => p.pred === l && p.gold !== l).length;
    const fn = pairs.filter((p) => p.pred !== l && p.gold === l).length;
    if (tp + fp + fn === 0) continue;
    const prec = tp / Math.max(1, tp + fp);
    const rec = tp / Math.max(1, tp + fn);
    const f1 = prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
    f1Sum += f1; n++;
  }
  return n === 0 ? 0 : f1Sum / n;
}

function pairF1(pairs) {
  const tp = pairs.filter((p) => p.pred === 1 && p.gold === 1).length;
  const fp = pairs.filter((p) => p.pred === 1 && p.gold === 0).length;
  const fn = pairs.filter((p) => p.pred === 0 && p.gold === 1).length;
  const prec = tp / Math.max(1, tp + fp);
  const rec = tp / Math.max(1, tp + fn);
  return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
}

function fieldF1(rows) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const gKeys = new Set(Object.keys(r.gold ?? {}).filter((k) => r.gold[k] != null));
    const pKeys = new Set(Object.keys(r.pred ?? {}).filter((k) => r.pred[k] != null));
    for (const k of gKeys) {
      if (pKeys.has(k) && String(r.pred[k]) === String(r.gold[k])) tp++;
      else fn++;
    }
    for (const k of pKeys) {
      if (!gKeys.has(k) || String(r.pred[k]) !== String(r.gold[k])) fp++;
    }
  }
  const prec = tp / Math.max(1, tp + fp);
  const rec = tp / Math.max(1, tp + fn);
  return prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
}

// ---- Heuristic predictors (mirror services/mlOps/predictors.ts) ----
const PAGE_HINTS = [
  [/press[-_ ]?release|prnewswire|businesswire/i, "press_release"],
  [/\/blog\/|medium\.com|substack/i, "blog_post"],
  [/news|techcrunch|reuters|forbes|axios/i, "news_article"],
  [/team|about|people/i, "team_page"],
  [/profile|linkedin\.com\/in/i, "profile"],
  [/^https?:\/\/[^/]+\/?$/i, "company_home"],
];

function predictPageClass(input) {
  const url = String(input?.url ?? "");
  const text = String(input?.text ?? "").slice(0, 1000);
  const blob = `${url}\n${text}`;
  for (const [re, label] of PAGE_HINTS) if (re.test(blob)) return label;
  return "other";
}

function predictCsvColumn(input) {
  const h = String(input?.header ?? "").toLowerCase();
  if (/email/.test(h)) return "email";
  if (/first.?name/.test(h)) return "first_name";
  if (/last.?name/.test(h)) return "last_name";
  if (/name/.test(h)) return "full_name";
  if (/company|org|firm/.test(h)) return "company";
  if (/title|role|position/.test(h)) return "title";
  if (/url|website|site/.test(h)) return "website";
  if (/linkedin/.test(h)) return "linkedin_url";
  if (/twitter|x\.com/.test(h)) return "twitter";
  if (/phone|mobile|tel/.test(h)) return "phone";
  return "unknown";
}

function predictRole(input) {
  const t = String(input?.title ?? "").toLowerCase();
  if (/founder|co.?founder/.test(t)) return "founder";
  if (/ceo|chief executive/.test(t)) return "ceo";
  if (/cto|chief technology/.test(t)) return "cto";
  if (/partner|managing director|principal/.test(t)) return "investor";
  if (/engineer|developer/.test(t)) return "engineer";
  if (/product/.test(t)) return "product";
  if (/operat/.test(t)) return "operator";
  return "other";
}

function predictDeal(input) {
  const text = String(input?.text ?? "");
  const round = (text.match(/series\s+([a-z])/i) || [])[1];
  const amount = (text.match(/\$([\d.]+)\s?(million|m|billion|b)/i) || [])[0];
  const usd = amount ? parseUsd(amount) : null;
  return {
    event_type: /acqui[rs]|acquisition/i.test(text) ? "acquisition" :
                /ipo|public offering/i.test(text) ? "ipo" : "funding_round",
    round_name: round ? `Series ${round.toUpperCase()}` : null,
    amount_usd: usd,
  };
}

function parseUsd(s) {
  const m = s.match(/\$([\d.]+)\s?(million|m|billion|b)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mul = /b/i.test(m[2]) ? 1e9 : 1e6;
  return Math.round(n * mul);
}

function predictDedupe(input) {
  const a = normalize(String(input?.a ?? ""));
  const b = normalize(String(input?.b ?? ""));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTok = new Set(a.split(/\s+/));
  const bTok = new Set(b.split(/\s+/));
  const inter = [...aTok].filter((t) => bTok.has(t)).length;
  const union = new Set([...aTok, ...bTok]).size;
  return inter / Math.max(1, union) >= 0.7 ? 1 : 0;
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function predictFounderBackground(input) {
  const text = String(input?.text ?? "").toLowerCase();
  const claim = String(input?.claim ?? "").toLowerCase();
  const claimTokens = claim.split(/\s+/).filter((t) => t.length > 3);
  if (claimTokens.length === 0) return 0;
  const hits = claimTokens.filter((t) => text.includes(t)).length;
  return hits / claimTokens.length >= 0.6 ? 1 : 0;
}

// ---- Runner ----
// Each fixture is `{task_key, examples: [{key, input, gold}, ...]}`.
// `goldKey(ex.gold)` and `predict(ex.input)` extract the comparison
// values; metric helpers then aggregate across the dataset.
const DATASETS = [
  { file: "page_classification.json", task: "page_classification", metric: "classification_f1",
    predict: (i) => predictPageClass({ url: i.url, text: `${i.title ?? ""} ${i.snippet ?? ""}` }),
    goldKey: (g) => g.label, predKey: (p) => p },
  { file: "csv_column_mapping.json", task: "csv_column_mapping", metric: "classification_f1",
    predict: (i) => predictCsvColumn({ header: i.header ?? i.column ?? "" }),
    goldKey: (g) => g.field ?? g.label, predKey: (p) => p },
  { file: "role_inference.json", task: "role_inference", metric: "classification_f1",
    predict: (i) => predictRole({ title: i.title ?? i.text ?? "" }),
    goldKey: (g) => g.role ?? g.label, predKey: (p) => p },
  { file: "deal_extraction.json", task: "deal_extraction", metric: "field_f1",
    predict: (i) => predictDeal({ text: i.text ?? i.body ?? "" }),
    goldKey: (g) => g, predKey: (p) => p },
  { file: "entity_dedupe.json", task: "entity_dedupe", metric: "pair_f1",
    predict: (i) => predictDedupe({ a: i.a ?? i.name_a, b: i.b ?? i.name_b }),
    goldKey: (g) => (g.is_match || g.label === "match" ? 1 : 0), predKey: (p) => p },
  { file: "founder_background.json", task: "founder_background", metric: "pair_f1",
    predict: (i) => predictFounderBackground({ text: i.evidence_text ?? i.text ?? "", claim: i.claim ?? "" }),
    goldKey: (g) => (g.is_verified || g.label === "verified" ? 1 : 0), predKey: (p) => p },
];

const results = {};
for (const d of DATASETS) {
  const path = join(GOLD_DIR, d.file);
  if (!existsSync(path)) { console.warn(`eval-local: missing ${d.file}, skipping`); continue; }
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(fixture) ? fixture : (fixture.examples ?? []);
  let metric;
  if (d.metric === "field_f1") {
    const fieldRows = rows.map((r) => ({ gold: d.goldKey(r.gold ?? r.gold_output_json), pred: d.predKey(d.predict(r.input ?? r.input_json)) }));
    metric = fieldF1(fieldRows);
  } else if (d.metric === "pair_f1") {
    const pairs = rows.map((r) => ({ gold: d.goldKey(r.gold ?? r.gold_output_json), pred: d.predKey(d.predict(r.input ?? r.input_json)) }));
    metric = pairF1(pairs);
  } else {
    const pairs = rows.map((r) => ({ gold: d.goldKey(r.gold ?? r.gold_output_json), pred: d.predKey(d.predict(r.input ?? r.input_json)) }));
    metric = classificationF1(pairs);
  }
  results[d.task] = { metric: d.metric, score: Number(metric.toFixed(4)), n: rows.length };
}

console.log("eval-local: scored", JSON.stringify(results, null, 2));

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + "\n");
  console.log(`eval-local: wrote baseline → ${BASELINE_PATH}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.warn("eval-local: no baseline file — run with EVAL_LOCAL_UPDATE=1 to create one. Soft-passing first run.");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
let failed = false;
for (const [task, cur] of Object.entries(results)) {
  const base = baseline[task];
  if (!base) { console.log(`eval-local: ${task} — no baseline, skipping`); continue; }
  const delta = (base.score - cur.score) * 100;
  const verdict = delta > THRESHOLD_PCT ? "FAIL" : "PASS";
  console.log(`eval-local: ${task} baseline=${base.score} current=${cur.score} Δ=${delta.toFixed(2)}pp [${verdict}]`);
  if (verdict === "FAIL") failed = true;
}

if (failed) {
  console.error(`eval-local: REGRESSION DETECTED (>${THRESHOLD_PCT}pp drop). Failing deploy.`);
  process.exit(1);
}
console.log("eval-local: all tasks within threshold.");
process.exit(0);
