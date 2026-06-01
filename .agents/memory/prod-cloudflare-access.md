---
name: Production behind Cloudflare Access
description: Why you can't verify api.aidatasignal.com endpoints with curl from the workspace.
---

Every endpoint on `https://api.aidatasignal.com` returns HTTP 302 (redirect to the
Cloudflare Access login) when hit server-side without an Access session — including
`/`, `/api/health`, `/api/power-nodes`, etc.

**Implication:** you cannot distinguish a 404 (missing route) from a 200 (working
route) by curling production from the workspace — Access intercepts the request
before it reaches the worker. End-to-end verification of prod endpoints needs a
browser session that has authenticated through Cloudflare Access (the allowlisted
operator), not a raw curl. Report prod checks as "verified as far as the Access
boundary allows" rather than claiming an endpoint resolved.
