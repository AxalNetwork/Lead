#!/usr/bin/env node
// Task #39: print the exact `wrangler secret put` commands needed to
// migrate the proxy failover pool secrets from the local shell
// environment to the Cloudflare worker. It only prints commands for
// secrets that are actually set, and NEVER prints their values — the
// `printf '%s' "$NAME" | wrangler secret put NAME` form reads the value
// from the environment at run time so it stays off your terminal and out
// of shell history.

const PROXY_SECRETS = [
  // forward proxies
  "PROXY_URL",
  "PROXY_AUTH",
  "SMARTPROXY_URL",
  "SMARTPROXY_AUTH",
  "BRIGHTDATA_URL",
  "BRIGHTDATA_AUTH",
  "OXYLABS_URL",
  "OXYLABS_AUTH",
  // API-mode providers
  "SCRAPERAPI_KEY",
  "SCRAPERAPI_COUNTRY",
  "SCRAPESTACK_KEY",
  "SCRAPESTACK_COUNTRY",
];

const set = PROXY_SECRETS.filter((name) => {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
});

if (set.length === 0) {
  console.error(
    "No proxy secrets are set in this environment. Set any of:\n  " +
      PROXY_SECRETS.join(", "),
  );
  process.exit(0);
}

console.log("# Run from apps/worker/. Values are read from the environment;");
console.log("# this script never prints the secret values themselves.\n");
for (const name of set) {
  console.log(`printf '%s' "$${name}" | npx wrangler secret put ${name}`);
}
