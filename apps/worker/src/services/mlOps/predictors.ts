// Task #8: deterministic heuristic predictors for the six gold tasks.
//
// These are NOT the production extractors — they are reference
// predictors the eval runner can exercise WITHOUT a live OpenAI key,
// so the eval pipeline (and the regression-gate CI script) is
// exercisable end-to-end in dev / CI. When OPENAI_API_KEY is set the
// caller can swap in an LLM-backed predictor that calls the same
// API; the runner contract (input → PredictResult) is identical.

import type { Predictor, TaskKey } from "./runner";

export function predictorFor(task: TaskKey): Predictor {
  switch (task) {
    case "page_classification": return pagePredictor;
    case "csv_mapping": return csvPredictor;
    case "role_inference": return rolePredictor;
    case "deal_extraction": return dealPredictor;
    case "entity_dedupe": return dedupePredictor;
    case "founder_background": return founderPredictor;
  }
}

const pagePredictor: Predictor = (input) => {
  const i = input as { url?: string; title?: string; snippet?: string };
  const blob = `${i.url ?? ""} ${i.title ?? ""} ${i.snippet ?? ""}`.toLowerCase();
  let label = "other";
  if (/\b(raise[sd]?|series [a-z]\b|seed round|pre-seed|closed.*round|funding|acquir(ed|es|ition)|ipo)\b/.test(blob)) label = "funding";
  else if (/\b(press release|announc|press\/)\b/.test(blob) || blob.includes("/press/") || blob.includes("/news/")) label = "press";
  else if (/(\/team|\/people|\/about\/people|our team)/.test(blob)) label = "team";
  else if (/(portfolio|companies|our work|\/work)/.test(blob)) label = "portfolio";
  else if (/\/(team|people)\/[a-z]/.test(blob) || /\bpartner\b|\bprincipal\b/.test(blob)) label = "profile";
  else if (/\/(blog|insights|posts|writing)/.test(blob)) label = "blog";
  return { predicted: { label } };
};

const csvPredictor: Predictor = (input) => {
  const h = String((input as { header?: string }).header ?? "").toLowerCase().trim();
  let field = "unknown";
  if (/mail/.test(h)) field = "email";
  else if (/(first|given|fname)/.test(h)) field = "first_name";
  else if (/(last|sur|lname)/.test(h)) field = "last_name";
  else if (/(phone|mobile|tel)/.test(h)) field = "phone";
  else if (/(company|org|employer)/.test(h)) field = "company";
  else if (/(title|role|position)/.test(h)) field = "title";
  else if (/linked/.test(h) || /^li\b/.test(h)) field = "linkedin_url";
  else if (/twitter|x handle|x_handle/.test(h)) field = "twitter_handle";
  else if (/(website|url|domain)/.test(h)) field = "website";
  else if (/country/.test(h)) field = "country";
  else if (/city/.test(h)) field = "city";
  return { predicted: { field } };
};

const rolePredictor: Predictor = (input) => {
  const t = String((input as { title?: string }).title ?? "").toLowerCase();
  let role = "other";
  if (/co-?founder|founder/.test(t)) role = "founder";
  else if (/^c[a-z]o\b|chief .* officer/.test(t)) role = "executive";
  else if (/(general|managing|venture) partner|principal|angel|investor|associate.*ventures/.test(t)) role = "investor";
  else if (/engineer|developer|sde/.test(t)) role = "engineer";
  else if (/product manager|\bpm\b/.test(t)) role = "product";
  else if (/designer|design lead/.test(t)) role = "design";
  else if (/account executive|sales|ae\b|bdr|sdr/.test(t)) role = "sales";
  else if (/marketing|growth|demand gen/.test(t)) role = "marketing";
  else if (/counsel|legal|attorney/.test(t)) role = "legal";
  else if (/chief of staff|operations|biz ?ops/.test(t)) role = "operations";
  else if (/advisor|board/.test(t)) role = "advisor";
  return { predicted: { role } };
};

const dealPredictor: Predictor = (input) => {
  const i = input as { title?: string; body?: string };
  const blob = `${i.title ?? ""} ${i.body ?? ""}`;
  const lc = blob.toLowerCase();
  const out: Record<string, unknown> = {};
  if (/\bacquir(ed|es|ition)\b/.test(lc)) out.event_type = "acquisition";
  else if (/\bipo\b|\bs-1\b/.test(lc)) out.event_type = "ipo";
  else out.event_type = "funding_round";
  const round = blob.match(/\b(Pre-Seed|Seed|Series [A-H]|Bridge|Extension|PIPE)\b/i);
  if (round) out.round_name = round[1].replace(/^series ([a-h])$/i, (_, l) => `Series ${l.toUpperCase()}`);
  const amt = blob.match(/\$\s?([\d,.]+)\s?(k|m|b|million|billion|thousand)?/i);
  if (amt) {
    const n = parseFloat(amt[1].replace(/,/g, ""));
    const unit = (amt[2] ?? "").toLowerCase();
    const mult = unit.startsWith("b") ? 1e9
      : unit.startsWith("m") ? 1e6
      : unit.startsWith("k") || unit.startsWith("t") ? 1e3
      : 1;
    out.amount_usd = Math.round(n * mult);
  }
  // Naive: company = capitalized token before "raises"/"closes"/"announces"/"acquired"
  const co = blob.match(/^([A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)?)\s+(?:raise|close|announce|acquir|files)/);
  if (co) out.company_name = co[1];
  else {
    const acq = blob.match(/acquir(?:es|ed)\s+([A-Z][A-Za-z0-9]*)/);
    if (acq) out.company_name = acq[1];
  }
  const lead = blob.match(/led by\s+([A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]+)*)/);
  if (lead) out.lead_investors = [lead[1]];
  return { predicted: out };
};

const dedupePredictor: Predictor = (input) => {
  const i = input as { a: Record<string, string>; b: Record<string, string> };
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripSuffix = (s: string) => s.replace(/(inc|llc|ltd|corp|capital|fund|ventures|labs)$/i, "");
  const da = (i.a.domain ?? "").replace(/^www\./, "").toLowerCase();
  const db = (i.b.domain ?? "").replace(/^www\./, "").toLowerCase();
  const sameDomain = Boolean(da && db && da === db);
  const na = stripSuffix(norm(i.a.name));
  const nb = stripSuffix(norm(i.b.name));
  const nameSim = Boolean(na && nb && (na === nb || na.includes(nb) || nb.includes(na)));
  let same = false;
  if (sameDomain && nameSim) same = true;
  else if (sameDomain && !i.a.company && !i.b.company) {
    // Same domain + different sub-brand: e.g. Stripe vs Stripe Capital. Only "same"
    // when neither side carries a sub-brand qualifier.
    same = !/(capital|labs|records|studio|foundation)/i.test(`${i.a.name} ${i.b.name}`);
  } else if (i.a.email && i.b.email) {
    same = i.a.email.toLowerCase() === i.b.email.toLowerCase();
  } else if (i.a.company && i.b.company) {
    same = nameSim && norm(stripSuffix(i.a.company)) === norm(stripSuffix(i.b.company));
  } else if (nameSim) {
    same = true;
  }
  return { predicted: { same } };
};

const founderPredictor: Predictor = (input) => {
  const i = input as { bio: string; claim: string };
  const bio = i.bio.toLowerCase();
  const claim = i.claim.toLowerCase();
  // Heuristic: claim is supported when claim's key noun-token appears in bio.
  const tokens = claim.split(/\W+/).filter((t) => t.length > 3 && !["studied","worked","holds","seat","prior","exit"].includes(t));
  const supported = tokens.length > 0 && tokens.every((t) => bio.includes(t));
  // Special claim handlers
  let final = supported;
  if (/prior exit/.test(claim)) final = /acquir|ipo|exit|sold/.test(bio) && !/first.time/.test(bio);
  else if (/board seat/.test(claim)) final = /board/.test(bio);
  else if (/has a phd|phd/.test(claim)) final = /\bphd\b|doctorate/.test(bio);
  return { predicted: { supported: final }, probability: final ? 0.85 : 0.15 };
};
