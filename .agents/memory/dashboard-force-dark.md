---
name: Dashboard force-dark surfaces
description: How to make a dashboard page/section stay dark regardless of the active theme without touching the global theme system.
---

# Force-dark a dashboard surface, theme-independently

To pin a dashboard page (or section) dark in ANY theme, **re-declare the dark
token VALUES scoped to the section's wrapper class** (e.g. `.ads-mr { --ads-panel:#121933; --ads-text:#e6ebff; ... }`) and set the wrapper's own
`background`/`color`. Every `var(--ads-*)` rule inside the wrapper then resolves
dark via the nearest-ancestor custom-property cascade.

**Do NOT** "force dark" by writing rules that reference `var(--ads-panel)` /
`var(--ads-text)` etc. directly.

**Why:** the design tokens flip to WHITE under `[data-theme="light"]`
(`--ads-panel:#ffffff`, `--ads-text:#161a2b` in `design.css`). The dashboard
theme defaults to `auto`, which follows the OS, so a light-mode operator gets
white-on-white. Any "hard-pin dark" block built on those tokens pins the
surface to white in light mode — this bug recurred several times on the
merge-review page before the scoped-token-redeclaration fix.

**How to apply:** the `!important` hard-pin rules that beat the legacy
bootstrap/marketing-CSS white leak (see dashboard-legacy-css-leak.md) can stay —
once the wrapper redeclares the tokens, those `var(--ads-*) !important` rules
resolve dark in every theme. Dark token values live in `design.css` `:root,[data-theme="dark"]`. Keep the override scoped to the wrapper so no other page
changes. Verify in LIGHT theme specifically (force `localStorage ads.theme=light`
+ `data-theme="light"`); a dark-themed preview proves nothing.
