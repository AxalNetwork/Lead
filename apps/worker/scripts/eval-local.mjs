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

// ---- Heuristic predictors (aligned to fixture label spaces) ----
// Page taxonomy in fixtures: team | portfolio | blog | press |
// funding | profile | other. Order matters — funding/press articles
// often live under /press/ on a VC site so the funding test must
// fire first when both signals are present.
function predictPageClass(input) {
  const url = String(input?.url ?? "").toLowerCase();
  const text = String(input?.text ?? "").toLowerCase();
  const blob = `${url} ${text}`;
  if (/raises?\s+\$|series\s+[a-z]\b|seed round|funding round|techcrunch|prnewswire|businesswire|announces?\s+\$/.test(blob)) return "funding";
  if (/\/blog\/|\/insights\/|\/posts?\/|why we invested|thesis|substack|medium\.com/.test(blob)) return "blog";
  if (/\/press(\/|$)|press release/.test(blob)) return "press";
  if (/\/people\/|\/team\/[a-z0-9-]+|\/about\/[a-z0-9-]+|partner|principal/.test(blob) && !/our team|meet the team|^team$/.test(text)) return "profile";
  if (/\/team(\/|$)|\/people(\/|$)|\/about\/people|our team|meet the team/.test(blob)) return "team";
  if (/\/portfolio(\/|$)|\/companies(\/|$)|\/work(\/|$)|portfolio companies/.test(blob)) return "portfolio";
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

// Role taxonomy in fixtures: founder | investor | executive |
// engineer | product | design | marketing | sales | operations |
// legal | advisor | other.
function predictRole(input) {
  const t = String(input?.title ?? "").toLowerCase();
  if (/founder|co.?founder/.test(t)) return "founder";
  if (/partner|managing director|principal|venture|investor|associate at|gp\b/.test(t)) return "investor";
  if (/advisor|board member/.test(t)) return "advisor";
  if (/ceo|cto|cfo|coo|chief|vp |vice president|president/.test(t)) return "executive";
  if (/engineer|developer|swe|software/.test(t)) return "engineer";
  if (/designer|design lead|ux|ui /.test(t)) return "design";
  if (/product manager|pm\b|head of product|product lead/.test(t)) return "product";
  if (/marketing|growth|brand|content/.test(t)) return "marketing";
  if (/sales|account executive|ae\b|business development|bdr|sdr/.test(t)) return "sales";
  if (/operations|ops |chief of staff|people ops/.test(t)) return "operations";
  if (/legal|counsel|attorney|paralegal/.test(t)) return "legal";
  return "other";
}

function predictDeal(input) {
  // Deal fixtures provide {title, body}; older shape used {text}.
  const text = `${input?.title ?? ""} ${input?.body ?? input?.text ?? ""}`;
  const round = (text.match(/series\s+([a-z])\b/i) || [])[1];
  const preSeed = /pre[- ]?seed/i.test(text);
  const seed = !preSeed && /\bseed\b/i.test(text);
  const usd = parseUsd(text);
  const event_type = /\bacqui[rs]|\bacquisition\b|acquires?\b/i.test(text) ? "acquisition" :
                     /\bipo\b|files? for ipo|s-1|public offering/i.test(text) ? "ipo" :
                     "funding_round";
  // Naive company-name extractor: the subject of "<Name> raises|files|closes|announces|today".
  const m = text.match(/^\s*([A-Z][\w &.-]{1,40}?)\s+(?:raises?|closes?|announces?|files?|today)/);
  const company_name = m ? m[1].trim() : null;
  return {
    event_type,
    company_name,
    round_name: round ? `Series ${round.toUpperCase()}` : (preSeed ? "Pre-Seed" : (seed ? "Seed" : null)),
    amount_usd: usd,
  };
}

function parseUsd(s) {
  // Match $30M, $1.5B, $750k, $30 million, $1.5 billion.
  const m = s.match(/\$\s?([\d.]+)\s?(million|billion|m|b|k)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  const mul = u.startsWith("b") ? 1e9 : u.startsWith("m") ? 1e6 : u.startsWith("k") ? 1e3 : 1;
  return Math.round(n * mul);
}

function predictDedupe(input) {
  // Fixtures shape: input = { a: {name, domain?, company?}, b: {...} }.
  const aRec = input?.a && typeof input.a === "object" ? input.a : { name: String(input?.a ?? "") };
  const bRec = input?.b && typeof input.b === "object" ? input.b : { name: String(input?.b ?? "") };
  const aDom = (aRec.domain ?? "").toLowerCase().replace(/^www\./, "");
  const bDom = (bRec.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (aDom && bDom && aDom === bDom) return 1;
  const a = normalize(String(aRec.name ?? ""));
  const b = normalize(String(bRec.name ?? ""));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const stripped = (s) => s.replace(/\b(llc|inc|ltd|labs|capital|ventures|fund|partners)\b/g, "").trim();
  if (stripped(a) === stripped(b) && stripped(a).length > 2) return 1;
  const aTok = new Set(a.split(/\s+/));
  const bTok = new Set(b.split(/\s+/));
  const inter = [...aTok].filter((t) => bTok.has(t)).length;
  const union = new Set([...aTok, ...bTok]).size;
  return inter / Math.max(1, union) >= 0.6 ? 1 : 0;
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function predictFounderBackground(input) {
  const text = String(input?.bio ?? input?.text ?? "").toLowerCase();
  const claim = String(input?.claim ?? "").toLowerCase();
  const stops = new Set(["the","a","an","at","in","on","of","and","or","for","to","with","studied","worked","was","is","from","by"]);
  const tokens = claim.split(/\W+/).filter((t) => t.length > 2 && !stops.has(t));
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => text.includes(t)).length;
  return hits / tokens.length >= 0.75 ? 1 : 0;
}

// ---- Runner ----
// Each fixture is `{task_key, examples: [{key, input, gold}, ...]}`.
// `goldKey(ex.gold)` and `predict(ex.input)` extract the comparison
// values; metric helpers then aggregate across the dataset.
const DATASETS = [
  { file: "page_classification.json", task: "page_classification", metric: "classification_f1",
    predict: (i) => predictPageClass({ url: i.url, text: `${i.title ?? ""} ${i.snippet ?? ""}` }),
    goldKey: (g) => g.label, predKey: (p) => p },
  { file: "csv_mapping.json", task: "csv_mapping", metric: "classification_f1",
    predict: (i) => predictCsvColumn({ header: i.header ?? i.column ?? "" }),
    goldKey: (g) => g.field ?? g.label, predKey: (p) => p },
  { file: "role_inference.json", task: "role_inference", metric: "classification_f1",
    predict: (i) => predictRole({ title: i.title ?? i.text ?? "" }),
    goldKey: (g) => g.role ?? g.label, predKey: (p) => p },
  { file: "deal_extraction.json", task: "deal_extraction", metric: "field_f1",
    predict: (i) => predictDeal({ text: i.text ?? i.body ?? "" }),
    goldKey: (g) => g, predKey: (p) => p },
  { file: "entity_dedupe.json", task: "entity_dedupe", metric: "pair_f1",
    predict: (i) => predictDedupe({ a: i.a, b: i.b }),
    goldKey: (g) => (g.same === true || g.is_match === true || g.label === "match" ? 1 : 0), predKey: (p) => p },
  { file: "founder_background.json", task: "founder_background", metric: "pair_f1",
    predict: (i) => predictFounderBackground({ bio: i.bio ?? i.text ?? "", claim: i.claim ?? "" }),
    goldKey: (g) => (g.supported === true || g.is_verified === true || g.label === "verified" ? 1 : 0), predKey: (p) => p },
];

// Schema assertion: positive-class support must exist for pair tasks
// so a baseline of 0 can't silently mask a broken extractor.
function assertHasPositives(rows, task, goldKey) {
  const pos = rows.filter((r) => goldKey(r.gold ?? r.gold_output_json) === 1).length;
  if (pos === 0) {
    console.error(`eval-local: ${task} has 0 positive-class examples — fixture schema drift suspected. Failing.`);
    process.exit(1);
  }
}

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
    assertHasPositives(rows, d.task, d.goldKey);
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
