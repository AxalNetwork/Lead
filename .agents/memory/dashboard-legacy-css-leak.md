---
name: Dashboard legacy CSS white-background leak
description: Why some dashboard pages render "white on white" under the dark theme, and the fix pattern.
---

The Jekyll site loads legacy marketing stylesheets (bootstrap.min.css,
style.css, plugins.css) site-wide via the default layout BEFORE the
dashboard design system (design.css defines the dark `--ads-*` tokens;
`:root` is dark by default). On dashboard pages, those legacy sheets can
**leak a white background** onto generic elements (cards, tables, td)
that the namespaced `.ads-*` rules don't pin hard enough. Under the dark
theme the text color stays near-white (`--ads-text: #e6ebff`), so a
leaked white panel produces unreadable **white-on-white**.

**Fix pattern:** pin the surface explicitly within the page's scoped
block with `background-color: var(--ads-panel/-2) !important` and
`color: var(--ads-text) !important` on the leaking elements (card,
column, table, td, tr). Namespacing alone (relying on `var(--ads-*)`
without `!important`) is NOT always enough to beat the legacy leak.

**Why:** equal-specificity legacy rules + source order can win over the
token-based dashboard rules on certain element types (notably bare
`table`/`td`).

**How to apply:** if an operator reports a dashboard page is
"white on white" / unreadable, look for bare-element backgrounds leaking
from the legacy sheets and add scoped `!important` dark overrides — don't
just switch the theme.
