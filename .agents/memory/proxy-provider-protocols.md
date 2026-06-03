---
name: Proxy provider protocol compatibility
description: Which proxy vendors actually work with the worker's tier2Proxy GET ?url= forward pattern, and why the "scraping API" vendors don't.
---

The worker's `tier2Proxy` (apps/worker/src/scraper/fetcher.ts) calls every
provider the SAME way: `GET <provider.url>?url=<encoded target>` with optional
`Authorization: Basic` from the provider auth. Workers `fetch()` cannot dial a
CONNECT proxy, so only **forward/unblocker endpoints that accept the target as a
`url=` query param** work. This is the load-bearing constraint.

**Compatible (work as-is):**
- Generic `PROXY_URL`/`PROXY_AUTH` — forward endpoint, 200.
- scrapestack (`api.scrapestack.com/scrape?access_key=...&url=...`) — 200.
- ScraperAPI (`api.scraperapi.com/?api_key=...&url=...`) — key valid, 200. Note:
  can be slow on heavy targets; worker per-attempt timeout is 20s (opts.timeoutMs
  default), so occasional `fetch_timeout:proxy` is expected, not a dead key.

**Incompatible with the GET `?url=` pattern (the vendors' *scraping API* products
use different protocols):**
- **Oxylabs** `realtime.oxylabs.io` — this is the Realtime API: **POST JSON**
  `{"source":"universal","url":...}` with Basic auth. Credentials are VALID
  (returns 200 + job), but the worker's GET shape gets **405**. Needs a POST
  adapter to use.
- **Smartproxy/Decodo** `scraper.smartproxy.org` / `scraper-api.smartproxy.com`
  — also a POST-JSON scraping API. The provided creds were rejected
  ("Username invalid" on v2; v1 paths 404). Not functional as configured.
- **Bright Data** `brd.superproxy.io:9515` — port 9515 is the **Scraping
  Browser** (CDP/Puppeteer over WebSocket), NOT an HTTP `?url=` API. The URL
  also embeds credentials, which makes `fetch()` throw synchronously
  ("Request cannot be constructed from a URL that includes credentials"). The
  tier2Proxy loop catches this and falls through, so it just wastes a slot.

**Why this matters:** adding a vendor secret is necessary but not sufficient —
the vendor must expose a GET forward-append unblocker endpoint, or the worker
needs a per-vendor adapter (POST body for Oxylabs/Smartproxy; CDP connect for
Bright Data Scraping Browser, or switch Bright Data to its Web Unlocker HTTP
product). Diagnostic script: `apps/worker/scripts/proxy-selftest.mjs`.

**How to apply:** before claiming a new proxy provider is "configured," run the
self-test from the workspace (secrets are present as env vars) — production
itself is behind Cloudflare Access and can't be curled.
