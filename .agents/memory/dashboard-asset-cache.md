---
name: dashboard asset cache-busting
description: Why a deployed Jekyll/site JS fix can fail to reach operators, and how to rule it out before assuming a code/worker bug.
---

# Dashboard JS stale-cache trap

Scripts loaded from the shared layout (`apps/site/_layouts/default.html`)
append `?v={{ site.time | date: '%s' }}`, so each Jekyll build invalidates
them. The per-page `<script src="/assets/js/*.js">` tags embedded directly
in `apps/site/dashboard/**/*.html` historically had NO cache-buster, so an
operator's browser can keep serving a stale cached copy long after a fix
ships.

**Why this matters:** it produces "I deployed the fix but the operator
still sees the broken behavior" confusion that looks like a worker/API bug
but is purely a client cache. When triaging a dashboard page that "doesn't
work for the operator" but works in local repro, check whether the page's
script tag is cache-busted before chasing the worker.

**How to apply:** when a page-script fix must reach operators immediately,
add `?v={{ site.time | date: '%s' }}` to that page's `<script src>` tag
(matches the layout convention). Broad cleanup tracked as a follow-up.

**Diagnostic note (Segments / taxonomies):** an API failure in the
dashboard's `api()` wrapper resolves to `null`, which renders as an EMPTY
STATE, not a perpetual spinner. So "all panels stuck on Loading" is a
front-end load-sequence symptom (e.g. sequential awaits where one hung
request blocks the rest), NOT a 404/stale-worker symptom — a stale worker
shows empty states. Load independent panels in parallel so one stalled
request can't freeze the others.
