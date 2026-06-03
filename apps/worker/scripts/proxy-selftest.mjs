// Ad-hoc connectivity self-test: exercises every configured proxy
// provider with the SAME URL/auth construction the worker's tier2Proxy
// uses, against a stable target. Reads creds from process.env.
import { getProxyProviders } from "../test-dist/scraper/proxyPool.js";

const TARGET = process.argv[2] || "https://httpbin.org/ip";
const TIMEOUT_MS = 25_000;

const providers = getProxyProviders(process.env);
if (providers.length === 0) {
  console.log("No proxy providers configured in this environment.");
  process.exit(0);
}

console.log(`Target: ${TARGET}`);
console.log(`Providers configured: ${providers.map((p) => p.name).join(", ")}\n`);

for (const p of providers) {
  const proxied = `${p.url}${p.url.includes("?") ? "&" : "?"}url=${encodeURIComponent(TARGET)}`;
  const headers = {};
  if (p.auth) headers["Authorization"] = "Basic " + Buffer.from(p.auth).toString("base64");
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(proxied, { method: "GET", headers, redirect: "follow", signal: ctl.signal });
    const body = await res.text();
    const ms = Date.now() - start;
    const snippet = body.replace(/\s+/g, " ").slice(0, 120);
    const verdict = res.ok ? "OK" : "FAIL";
    console.log(`[${p.name}] ${verdict}  status=${res.status}  ${ms}ms  bytes=${body.length} (${p.mode ?? "forward"})`);
    console.log(`    body: ${snippet}`);
  } catch (e) {
    const ms = Date.now() - start;
    const reason = e.name === "AbortError" ? `timeout>${TIMEOUT_MS}ms` : `${e.name}: ${e.message}`;
    console.log(`[${p.name}] ERROR  ${ms}ms  ${reason} (${p.mode ?? "forward"})`);
  } finally {
    clearTimeout(tm);
  }
}
