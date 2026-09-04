# Claude Design prompts — dashboard UX improvements

Prompts to paste into Claude Design (or any design canvas) to improve the
operator experience of the admin dashboard in `apps/site`. Each prompt is
self-contained: prepend the **shared context** block, then the prompt.
They are ordered by leverage — the first four change every page.

The prompts describe what exists today with file paths so a designer (or
the next implementation pass) can trace each decision back to real code.

---

## Shared context (prepend to every prompt)

> You are designing screens for **AI Data Signal**, a single-operator
> lead-intelligence admin platform. One expert user (an investor /
> deal-flow analyst) uses it all day to review people, firms, companies,
> deals, and the crawlers that collect them. It is a static Jekyll site
> served from GitHub Pages that calls a Cloudflare Worker API; there is no
> server-side rendering, and detail pages are addressed by query string
> (`/dashboard/firms/?id=…`), never by path segment.
>
> **Existing design system** (`apps/site/assets/css/design.css` and
> `dashboard.css`): dark-first (`data-theme="dark"`) with a complete light
> overlay; `--ads-*` tokens for color, spacing, type, shadow, and focus
> ring; BEM-ish `ads-*` components — `ads-card`, `ads-table` inside
> `ads-table-wrap`, `ads-btn` (primary / ghost / danger), `ads-field`,
> `ads-tabs`, `ads-toast`, `ads-modal`, `ads-skeleton`, `ads-empty`,
> `ads-empty-state`, `ads-badge`. Layout: a collapsible left rail
> (`_includes/shell/sidenav.html`, 7 groups / ~40 links) plus a sticky
> topbar with page title, ⌘K command palette, theme toggle, alerts bell,
> and sign-out avatar. Typography is a humanist sans; density is
> "data-dense but breathable" (14px base, 8px spacing scale).
>
> **Constraints:** keep the token vocabulary and component names so the
> design maps 1:1 onto existing CSS; both themes must work; no new
> JavaScript frameworks; every list must survive 10,000 rows via
> pagination or "load more"; every write action is asynchronous and can
> fail with an HTTP status plus a request id that the operator can quote
> to support. Deliver artboards at 1440×900 and 390×844 unless the prompt
> says otherwise, and name every component you introduce.

---

## 1. Navigation rail and information architecture

**Today.** `_includes/shell/sidenav.html` has seven groups (Home,
Discover, Network, Intelligence, Research, Operations) and ~40 links,
none collapsible. Two Research items are stubs (`coming-soon`). The six
`/ops/*` consoles were only reachable via the Quality Console link until
this audit added them, so Operations now holds 17 links. Active state is
string-matching on the URL; there is no grouping by frequency of use.

**Prompt.**
Redesign the left rail for a 40-destination admin app used by one
expert. Propose an information architecture with at most 6 top-level
groups, collapsible groups that remember their state, and a "pinned"
section the operator can populate (max 6). Show: expanded rail, collapsed
icon-only rail with tooltips, and the mobile drawer. Distinguish
*workspaces* (People, Firms, Companies, Deals…) from *ops consoles*
(Crawler Ops, Incidents, Quality, Compute Nodes, Garbage Review) visually
so the operator never lands in an ops console by accident. Include a
rail footer with environment badge (prod/staging), version, and sign-out.
Deliver the group/link inventory as a table mapping every current href
to its new group so nothing is lost.

## 2. The universal list page

**Today.** Roughly 40 list pages (`assets/js/investors.js`, `firms.js`,
`companies.js`, `people-list.js`, `leads.js`, `jobs.js`, `errors.js`,
`documents.js`, …) each hand-build an HTML string table. Sorting is
server-side click-to-sort on only five pages; pagination is a per-page
"Load more" button with `limit`/`offset`; filters are ad-hoc forms above
the table; bulk actions come from `bulk-bar.js` on a subset of pages.
Loading is a literal "Loading…" div; empty is `.ads-empty`; errors are
`"Error: " + e.message` (raw "HTTP 500").

**Prompt.**
Design one canonical **List Page** template that every entity list will
adopt. Components: filter bar (chips + a "more filters" popover, saved
filter presets, clear-all), result summary ("1,240 firms · sorted by
updated"), data table with sortable headers, sticky header, column
visibility menu, density toggle, row hover actions, checkbox selection
with a floating bulk-action bar (enrich, tag, assign role, merge,
delete, export), and cursor pagination ("Showing 1–50 of 1,240", page
size selector). Specify loading (skeleton rows matching the column
layout), empty (with a primary action such as "Run a crawler" or "Import
a CSV"), and error (request id, retry, "report" link) states. Show the
template applied to Firms and to Jobs (very different columns: one is
entity data, the other is status/timing). Include the 390px layout where
the table becomes cards.

## 3. The universal detail page

**Today.** Detail pages are `?id=` pages such as `dashboard/firm-detail.html`
(six scripts plus tabs), `investor-detail.html`, `company-detail.html`,
`account-detail.html`, `lead.html`, `profile.html`. Only 9 of 86 pages
have back navigation or a breadcrumb; several have no `<h1>`; identity
(name, kind, badges) is rendered differently on each; "embedded" tabs
(`_includes/components/embedded-profile.html`, `embedded-news.html`,
`embedded-cap-table.html`, `embedded-mark-map.html`) each load
independently with their own spinners.

**Prompt.**
Design a **Detail Page** template for an entity (person / firm / company)
with: breadcrumb (`Firms › Acme Ventures`), identity header (avatar or
logo, name, type badge, verification status, watch-star, quality score,
primary actions: Enrich · Edit · Merge · Add to watchlist · Export PDF),
a left-hand "at a glance" column (key facts with provenance chips and
last-observed dates), and a tabbed main area (Overview, Facts, News,
Relationships, Deals, Documents, Activity). Tabs must deep-link
(`?id=…&tab=news`) and render a skeleton per tab while loading. Show the
Facts tab with inline edit: hover reveals an edit affordance; a locked
override shows a lock icon with "overridden by <email> on <date>"; a
history drawer lists prior values. Design the "nothing here yet" state
for a tab (e.g. no news) with the action that would populate it. Provide
the mobile stack.

## 4. Feedback: replace alert() / confirm() / prompt()

**Today.** ~35 call sites still block the UI with `alert()`,
`confirm()`, or `prompt()` — worst in `assets/js/field-edit.js`
(10, some dumping `JSON.stringify(res)` at the user),
`dashboard/projects/workspace.html`, `ops-crawler.js`,
`ops-compute-nodes.js`. Eight market-intel pages confirm a snapshot with
`alert("Snapshot saved: /dashboard/…/snapshot/?id=…")` and no link.
A toast stack (`ADS.ui.toast`) and modal (`ADS.ui.modal`,
`confirmDestructive`) already exist in `assets/js/ui.js` but are used by
only a handful of pages.

**Prompt.**
Design the complete **feedback system**: (a) toast variants — success,
info, warning, error — with optional action link ("Snapshot saved ·
Open"), auto-dismiss rules, stacking, and a "copy request id" affordance
on errors; (b) a confirm modal for reversible actions and a
type-to-confirm modal for destructive ones (delete entity, purge
garbage), showing scope ("This affects 42 records"); (c) an input modal
replacing `prompt()` (create entity: name, kind, role, website, "run AI
fill" toggle); (d) inline validation on forms; (e) a long-running action
pattern (button → progress pill → result toast) for enrich / crawl /
export that can take 10–90 seconds. Provide a decision table: which
pattern to use for which action class.

## 5. Loading, empty, and error vocabulary

**Today.** `Loading…` text (78 occurrences), `.ads-empty` (23), raw
error strings, and eight market-intel pages that stay blank until a
`/kpi` call succeeds (`assets/js/dashboards.js` `gate()`). The richer
`.ads-empty-state` and `.ads-skeleton` components exist in CSS with zero
usages.

**Prompt.**
Define the platform's **state vocabulary** as a component sheet:
skeletons for table, card grid, KPI row, chart, and detail header; empty
states with an illustration slot, one-line explanation, and a primary
action, in three sizes (page, card, tab); error states for 401 (session
expired → sign in), 403 (not allowed), 404 (entity not found →
back to list), 429/5xx (retry with backoff), and offline. Every error
shows a request id and a "Copy details" action. Also design the
"access pre-flight" moment for gated dashboards: show the page skeleton
immediately and only swap in an error card if the probe fails. Provide
motion guidance (shimmer speed, fade-in) and reduced-motion fallbacks.

## 6. Market-intelligence dashboards and snapshots

**Today.** Eight sibling pages (`funds-raising`, `capital-markets`,
`sector-momentum`, `geographic-flow`, `lp-network`, `partner-moves`,
`vintage-benchmarks`, `angel-finder`) share `assets/js/dashboards.js`:
KPI tiles, five SVG chart primitives, CSV export, and "Save snapshot",
each with a 12-line read-only `snapshot.html` that hydrates strictly from
the stored payload via `snapshot-viewer.js`. Headings use a second
convention (`ads-h1`/`ads-section`) unlike the rest of the app.

**Prompt.**
Design the **Dashboard family** template: page header with title,
date-range control, refresh timestamp, and actions (Export CSV · Save
snapshot · Share); a KPI strip (4–6 tiles with delta vs prior period and
sparkline); a responsive chart grid (bar, line, stacked area, heat map,
network mini-map) with consistent legend placement, hover tooltips, and
an "expand" action per chart; and a data table beneath the charts. Then
design the **Snapshot viewer**: a read-only banner ("Snapshot taken 12
May 2026 14:02 by <operator>"), the same layout frozen, a "Compare to
live" toggle, and a share/copy-link affordance. Apply the template to
Sector Momentum (time series) and LP Network (graph-heavy) to prove it
generalises. Charts must use a categorical palette that reads in both
themes and is colour-blind safe.

## 7. Operations home and ops consoles

**Today.** Six `/ops/*` consoles plus `/dashboard/health/`,
`/dashboard/errors/`, `/dashboard/jobs/`, and `merge-review` are separate
pages with separate styles; `ops-crawler.js` is 32 KB and shows results
via `alert(JSON.stringify(...))`; `ops-incidents.js` and
`ops-system-health.js` render raw JSON. There is no single place to see
"is the platform healthy right now".

**Prompt.**
Design an **Operations home** that answers "what needs me?" in five
seconds: a status header (overall health with the last snapshot time),
open incidents with severity and age, crawler throughput and error rate
for the last 24h, queue depth and stuck jobs, budget burn (AI neurons,
subrequests, proxy spend) as meters, and a "recent actions" audit list.
Then design the **Incident detail** (timeline, affected hosts/jobs,
delivery status of alerts, resolve/acknowledge actions) and the **Crawler
Ops** console (per-host table with pause/resume, backoff state, robots /
ToS blocks shown as benign skips not errors, a replay action with an
in-page result panel instead of an alert). Use a consistent status
semantic: healthy / degraded / paused / failing / unknown, each with an
icon, colour, and plain-language label.

## 8. Home ("Today") page

**Today.** `dashboard/index.html` shows KPI tiles, a tabbed scrape/import
panel, recent leads, and recent jobs, rendered by the 1,000-line
`assets/js/dashboard.js`.

**Prompt.**
Redesign **Today** as a personal cockpit for one operator: greeting with
data freshness ("last crawl 14 min ago"), "needs review" queue counts
(merge candidates, OSINT candidates, garbage flags, failed imports) that
deep-link into the queues, a "what changed since yesterday" feed from
watchlists and alerts, quick actions (Import CSV, Run crawler, Ask
research agent), and a compact jobs strip. Design for a fast morning
scan: hierarchy first, charts second. Include the empty first-run state
for a fresh install with no data.

## 9. Import wizard

**Today.** Uploads land on `dashboard/uploads.html` and are configured in
`assets/js/dashboard.js` (column mapping, tab selection, `confirm-map`,
`rerun`, `save-template`) inside the Today page's tabbed panel; progress
is polled; failures surface as text.

**Prompt.**
Design a five-step **Import wizard**: (1) drop zone accepting CSV / XLSX /
PDF / paste, with format detection and a sheet picker for workbooks;
(2) column mapping with auto-detected suggestions, confidence chips,
sample values per column, and the ability to save the mapping as a
template; (3) options (entity type, dedupe strategy, scrape URLs found
in rows); (4) live progress with rows processed / created / merged /
skipped and a cancel action; (5) results with a per-row issues table and
"fix and re-run" for the failed subset. Show validation inline (a
required column unmapped) and the resume state for an import that was
interrupted.

## 10. Inline field editing and overrides

**Today.** `assets/js/field-edit.js` injects light-coloured inputs
(`background:#fff;color:#1a1a1a`) into the dark UI, confirms with
`alert()`, and offers lock / unlock / history / soft-delete actions via
`prompt()`.

**Prompt.**
Design the **inline edit** interaction for a fact row: rest state,
hover (edit affordance + provenance popover with source URL and
confidence), edit state (typed input per value kind: text, number,
currency, date, enum, entity picker), save/cancel with keyboard support,
and the post-save state showing "overridden · locked" with a tooltip.
Include the unlock flow (reason required, optional auto-unlock date), the
history drawer (value, source, who, when, "restore" action), and the
soft-delete confirmation. Both themes; tokens only.

## 11. Research agent workspace

**Today.** `dashboard/research.html` is 630 lines of inline script: a
prompt box, a streamed answer area, entity cards with actions (open,
watch, email, intro, compare), and saved research at `coming-soon`.

**Prompt.**
Design a **Research workspace** with a left list of saved threads, a
central conversation pane (user turns, agent turns with inline citation
pills that open the source, tool-call "steps" that can be expanded,
token/budget meter), and a right rail of "entities mentioned" cards with
one-click actions (open, watch, add to project, draft outreach). Include
a compose bar with suggested prompts, attachment of a watchlist or
project as context, and a stop/regenerate control. Show the empty state
with example questions and the daily-budget-exhausted state.

## 12. Responsive and mobile pass

**Today.** `dashboard.css` has ten media queries, but the rail has no
per-group collapse, ~40 hand-rolled tables and many `.ads-table` uses sit
outside `.ads-table-wrap`, and inline `style="margin-top:16px"` spacing
is everywhere.

**Prompt.**
Produce a **responsive spec** at 390, 768, 1024, and 1440px for the list,
detail, dashboard, and ops templates from prompts 2, 3, 6, and 7: which
columns collapse into a row-card, where filters move (bottom sheet), how
bulk actions surface, how charts reflow, and how the rail becomes a
drawer. Define a spacing utility scale (`ads-mt-2` … `ads-mt-6`) to
replace inline margins.

## 13. Design tokens and theme consolidation

**Today.** Two heading conventions coexist (`ads-page-title`/`ads-page-sub`
on 52 pages vs `ads-h1`/`ads-sub`/`ads-section` on 24); several scripts
hard-code light colours; the dashboard still loads ~500 KB of unused
marketing CSS (`bootstrap.min.css`, `plugins.css`, `style.css`).

**Prompt.**
Produce a **design-token sheet** for both themes: colour roles
(surface 0–3, border, text primary/secondary/muted, accent, success,
warning, danger, info, chart categorical 1–8, chart sequential),
typography scale (display, h1, h2, h3, body, caption, mono), spacing,
radii, shadows, focus ring, and motion. Show contrast ratios for every
text/surface pair. Define one heading convention and a page-header
component. Include a migration table mapping each legacy class to its
replacement.

## 14. Command palette and global search

**Today.** `assets/js/cmdk.js` opens a ⌘K palette that lists rail links
(`data-cmdk-nav`) and can query `/api/search`.

**Prompt.**
Design the **command palette**: navigation items, recent entities,
typed search results grouped by kind (people, firms, companies, deals)
with keyboard navigation, and actions ("Run crawler on…", "Create
entity", "Toggle theme"). Show the loading and no-results states and the
mobile presentation.

## 15. Alerts bell and Alerts page

**Today.** `assets/js/alerts-bell.js` renders a dropdown of recent alerts
with unread count; `dashboard/alerts.html` lists events with filters and
ack/read actions.

**Prompt.**
Design the **notification system**: bell dropdown (grouped by day, unread
emphasis, mark-all-read, "view all"), the Alerts page (filter by
watchlist, trigger kind, severity; bulk acknowledge; an event detail
side-panel with the diff that triggered it and a link to the entity), and
the alert-rule editor (trigger kind, channel, digest frequency, dedupe
window) with a preview of what would have fired in the last 7 days.
