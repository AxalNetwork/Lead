# Claude Design prompts — mobile (Turn 2)

Continues the canvas at artifact `1dd7c706` ("Turn 1 · Baseline"), which
recreates four desktop screens at 1440×900: **1a Today**, **1b Firms**,
**1c Firm detail**, **1d Jobs**. These prompts design the mobile
counterparts of those same four, then the patterns the rest of the app
inherits.

Prompt 0 is the shared context — prepend it to every other prompt. The
first four are the direct mobile counterparts and are worth doing in
order; 5–8 cover the patterns every remaining screen depends on.

---

## 0. Shared context (prepend to every prompt)

> You are designing the **mobile** views of **AI Data Signal**, a
> single-operator lead-intelligence admin. One expert user — an investor
> / deal-flow analyst — works in it all day. On desktop they triage
> hundreds of rows; on a phone they are checking something between
> meetings, reviewing what changed, or approving a queue. Design for the
> second case rather than shrinking the first.
>
> **Continuity.** This continues the canvas whose Turn 1 is a faithful
> baseline of the current desktop admin. Keep the same visual language so
> the two read as one product.
>
> **Design system — use these exact tokens.** The app is dark-first with
> a full light overlay; every value below is a real CSS custom property
> in `apps/site/assets/css/design.css`, so name the token rather than
> hardcoding the hex:
>
> | Token | Dark | Role |
> |---|---|---|
> | `--ads-bg` | `#0b1020` | page ground |
> | `--ads-bg-elev` | `#070b1c` | rail / elevated chrome |
> | `--ads-panel` | `#121933` | card, input |
> | `--ads-panel-2` | `#1a2347` | active / hover |
> | `--ads-border` | `#243066` | hairline |
> | `--ads-border-strong` | `#324585` | emphasis border |
> | `--ads-text` | `#e6ebff` | body |
> | `--ads-text-strong` | `#ffffff` | headings, active |
> | `--ads-muted` | `#8b94c2` | secondary, labels |
> | `--ads-accent` | `#5b8cff` | primary action, focus |
> | `--ads-accent-2` | `#23d6a4` | success |
> | `--ads-warn` | `#ffb547` | warning |
> | `--ads-danger` | `#ff5d6c` | danger |
>
> Score colours (`--ads-score-low/mid/good/great`) run danger → warn →
> `#23d6a4` → `#15a880`. Radii `--ads-r-1..3`, shadows
> `--ads-shadow-1..3`, motion `--ads-dur` / `--ads-ease`.
>
> **Components that already exist** — extend them, don't invent
> parallels: `ads-card`, `ads-table` inside `ads-table-wrap`, `ads-btn`
> (primary / ghost / danger), `ads-field`, `ads-tabs`, `ads-toast`,
> `ads-modal`, `ads-pill` (`.ok` / `.warn` / `.err` / `.idle`),
> `ads-skeleton`, `ads-empty`, `ads-empty-state`, `ads-rail`,
> `ads-page-title` / `ads-page-sub`.
>
> **Hard constraints.**
> - Static Jekyll on GitHub Pages calling a Cloudflare Worker API. No
>   server-side rendering, no router: detail pages are addressed by query
>   string (`/dashboard/firms/detail/?id=…`), never a path segment.
> - Cloudflare Access fronts the API. A session can expire mid-use, so
>   every screen needs a credible re-auth path.
> - Both themes must work. Never hardcode a colour — the current code has
>   112 hardcoded light values that bleed into the dark UI, and this pass
>   must not add more.
> - Touch targets ≥ 44×44 px. Primary actions reachable one-handed
>   (bottom half of the screen).
> - Lists can hold tens of thousands of rows; assume paging, never
>   "render everything".
>
> **Deliverables per prompt:** artboards at **390×844** (iPhone
> baseline), plus **360×800** where a layout is tight, and the 768px
> tablet breakpoint where behaviour changes. Name every component you
> introduce, and state which existing `ads-*` class it extends.

---

## 1. Navigation — replacing a 40-item rail on a phone

**Baseline.** Turn 1 shows the 240px `AdsRail`: brand, then Home +
5 groups (Discover, Network, Intelligence, Research, Operations) totalling
~40 links, with a `v2 UI` footer. At 390px that rail cannot simply
collapse — it is longer than the screen twice over.

**Prompt.**
Design mobile navigation for a 40-destination admin used by one expert.
Deliver three parts:

1. **Bottom tab bar** — 4–5 destinations maximum, chosen for what someone
   actually opens on a phone. Argue the selection explicitly (my starting
   hypothesis: Today, People/Firms search, Review queues, Alerts, More).
   Show active and inactive states and a badge for unread counts.
2. **"More" sheet** — the full 40-link inventory, grouped as today,
   searchable, with a pinned section the operator fills themselves
   (max 6). Show the collapsed and expanded group states.
3. **Contextual back** — since detail pages carry `?id=`, mobile needs a
   reliable way back to the list, including on a cold load from a shared
   link where there is no history. Design that header.

Provide a table mapping every one of the ~40 current rail links to its
new home (tab, More group, or reachable only from a parent screen), so
nothing is silently lost.

## 2. `1a Today` on mobile — the morning check

**Baseline.** Desktop Today is a topbar (rail toggle, title, search with
a ⌘K hint, theme, alerts bell, avatar) above KPI tiles, a tabbed
scrape/import panel, recent leads and recent jobs.

**Prompt.**
Redesign **Today** for a phone as the answer to "what needs me?" in five
seconds. Include: a freshness line ("last crawl 14 min ago"), a
**needs-review** row of counts that deep-link into their queues (merge
candidates, OSINT candidates, garbage flags, failed imports), a "what
changed since yesterday" feed from watchlists and alerts, and a compact
jobs strip. Demote the KPI tiles — on a phone they are reference, not
headline — and show how they collapse into a single swipeable row.

⌘K has no mobile equivalent: design the search entry point that replaces
it. Include the first-run empty state for a fresh install with no data,
and the loading state as skeletons matching the final layout rather than
a spinner.

## 3. `1b Firms` on mobile — a data table without a table

**Baseline.** Desktop Firms is a filter bar over a sortable
`ads-table`: name, kind, HQ country/city, typical check, AUM, portfolio
count, unicorns, exits, founded year, quality score, last modified.
Sorting is server-side (`sort_by` / `sort_dir` against a whitelist),
paging is `limit`/`cursor`, and a "Load more" button appends.

**Prompt.**
Design the mobile **list** pattern, using Firms as the worked example.
A 12-column table cannot survive 390px, so design the **row card**: which
2–3 fields earn the primary line, which become secondary metadata, and
where the quality score sits (it is the operator's main triage signal —
use the score colour ramp). Then design:

- **Filters** as a bottom sheet: chips for active filters shown above the
  list, "clear all", and saved presets.
- **Sort** as its own control, since sorted columns no longer exist —
  make the current sort visible without opening anything.
- **Paging**: "Load more" versus infinite scroll on a phone — pick one,
  justify it, and show the boundary state ("Showing 50 of 1,240").
- **Bulk selection**: how multi-select and the bulk action bar work with
  a thumb (enrich, tag, assign role, merge, delete, export).

Show loading (skeleton cards), empty (with the action that would populate
it), and error — including the 401 case where the Access session expired
and the operator must re-authenticate without losing their filters.

## 4. `1c Firm detail` on mobile — and the breadcrumb that is missing

**Baseline.** Desktop firm detail is the heaviest screen: six external
scripts plus an inline one, tabs for profile / news / cap table / mark
map. Turn 1 annotates it as having **no breadcrumb** — I verified that:
the page has an `<h1>` and the rail *does* highlight Firms (its permalink
is `/dashboard/firms/detail/`), but there is no breadcrumb anywhere.

**Prompt.**
Design the mobile **detail** pattern using Firm detail. Include: a
sticky header carrying back-to-list plus the entity name (truncating
gracefully), an identity block (logo, name, type badge, verification
state, quality score, watch-star), a primary action row that stays
reachable one-handed (Enrich · Edit · Merge · Watch · Export PDF —
decide which are primary and which go in an overflow), and tabbed
content that deep-links (`?id=…&tab=news`) and skeletons per tab.

Design the **breadcrumb** this screen lacks, in a form that works at
390px — likely a single "‹ Firms" affordance rather than a full trail —
and specify its behaviour on a cold load from a shared link.

Then design the **fact row with provenance**: value, source chip,
confidence, last-observed date, and the locked-override state
("overridden by <email> on <date>") — plus its inline edit on touch,
where hover does not exist.

## 5. `1d Jobs` on mobile — an ops queue you can act on

**Baseline.** Desktop Jobs requests `limit=200` and filters the date
range **client-side**, so a date filter can legitimately find nothing
because the match is older than the most recent 200. The page already
carries a note explaining this — both facts verified in `jobs.js`.

**Prompt.**
Design the mobile **ops queue** using Jobs. A job row needs status,
kind, target, age, duration and error code — design its card so status
is scannable in a fast scroll (use `ads-pill` semantics: ok / warn / err
/ idle, plus `skipped` as a distinct benign state, not an error). Design
filters for status / kind / source, and the row actions (retry, cancel,
view error).

Treat the 200-row cap as a design problem rather than a footnote: show
how the UI communicates "you are looking at a window, not the whole
table" at the moment a date filter returns nothing — and propose the
interaction that gets the operator to older rows.

Include the failure state where a job's error is a long stack or a
provider payload: on a phone that must collapse to a code plus a "copy
details" action, never a wall of monospace.

## 6. Feedback, and the end of `alert()`

**Baseline.** ~35 call sites still use blocking `alert()` / `confirm()`
/ `prompt()`, some dumping raw JSON at the user. A toast stack and modal
already exist in `assets/js/ui.js` and are used by only a handful of
pages.

**Prompt.**
Design the mobile **feedback system**: toasts (success / info / warning /
error) positioned clear of the bottom tab bar, with an optional action
and a "copy request id" affordance on errors; a confirm sheet for
reversible actions and a type-to-confirm sheet for destructive ones,
each stating scope ("this affects 42 records"); an input sheet replacing
`prompt()`; and the long-running action pattern — enrich, crawl and
export can take 10–90 seconds, so show button → progress → result
without trapping the operator on the screen. Provide a decision table:
which pattern for which action class.

## 7. State vocabulary on a small screen

**Baseline.** Loading is a literal "Loading…" div (78 occurrences);
`.ads-skeleton` and `.ads-empty-state` exist in CSS with zero usages;
errors surface as raw strings like `HTTP 500`.

**Prompt.**
Produce the mobile **state sheet**: skeletons for list card, detail
header, KPI row and chart; empty states in three sizes with an
illustration slot and a primary action; and error states for 401
(session expired → re-authenticate), 403, 404 (entity gone → back to
list), 429/5xx (retry with backoff) and offline. Every error shows a
request id and a copy action. Include reduced-motion fallbacks and state
the shimmer timing.

## 8. Responsive contract

**Prompt.**
Write the **breakpoint spec** that carries prompts 1–5 across 390, 768,
1024 and 1440px: at which width the row card becomes a table row, where
filters move (sheet → inline bar), how the bottom tabs become the rail,
how bulk actions transition, and how the detail tabs reflow. Define a
spacing scale to replace the inline `style="margin-top:16px"` used on
nearly every card today, and note which existing `ads-*` classes each
new class sits beside.

---

## Two notes for whoever picks this up

**The canvas is a baseline, not a target.** Artifacts `04fee0f5` and
`1dd7c706` recreate the current desktop admin — the `AdsRail` component
inlines the shipped design tokens as literal hex, and the four artboards
mirror today's markup. They are the "before" to design against, not a
new design to implement.

**Verify the annotations.** Of Turn 1's three notes, two are accurate —
the Firms header really did use `#eee`/`#667` (fixed), and Jobs really
does cap at 200 rows with a client-side date filter. The third, "no
active rail item" on firm detail, is not: the permalink is
`/dashboard/firms/detail/` and the rail's `contains '/dashboard/firms'`
rule matches it. The missing breadcrumb in that same note is real.
