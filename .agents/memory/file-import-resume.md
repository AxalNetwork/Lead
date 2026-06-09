---
name: Legacy file-import resume + watchdog
description: Why legacy file_imports got stuck in 'importing' and the crash-consistency rules the chunked/resumable processor relies on.
---

# Legacy file-import (`file_imports`) chunked resume

**Root cause of "stuck in importing":** `processImportFile` ran every row of
every tab in ONE queue invocation. The leads path is subrequest-heavy per row
(DNC scrub + resolveIncoming fact chain + match/merge), so even a few hundred
rows blew the Cloudflare Worker per-invocation subrequest budget. The isolate
was killed BEFORE the try/catch could set `status='error'`, so the row stayed
`importing` forever with no watchdog.

**Design now: cost-based budgeting + cursor resume.** Per-invocation
`SUBREQUEST_BUDGET` with per-intent `ROW_COST`; when the next row would exceed
budget the processor checkpoints and re-enqueues a resume `import_file` job.
Resume cursor + per-tab cumulative counters live on the rows (migration 381).
Finalize rebuilds the summary purely from `file_import_tabs` DB rows, so it is
correct regardless of how many chunks contributed.

## Crash-consistency rules (don't regress these)
- **Flush buffered lead inserts BEFORE persisting cursor/counters.** Counters
  must never run ahead of the actual writes; reruns are idempotent (upsert /
  dedupe-merge) so re-processing a chunk is safe.
- **Cursor + counters must advance ATOMICALLY.** Both the mid-tab budget
  checkpoint and the tab-boundary commit batch `[tabCumStmt, accStmt]` in one
  `env.DB.batch` (D1 implicit txn). A non-atomic split lets an isolate kill
  leave a tab counted while the cursor still points inside it → double-count on
  resume. Tab-end advances cursor to `(tabIndex+1, 0)`; the resume skip is
  `i < cursorTab`, so this is correct even with sparse/non-contiguous tab_index.
- **Resume seeding:** seed the in-progress tab (`i === cursorTab`) from its
  persisted cumulative row; later tabs start from ZERO; tabs `< cursorTab` are
  skipped.

## Watchdog (`sweepStuckImports`, hourly cron) — never deadlock
- An import is recoverable when `status='importing'` AND `updated_at` is >10 min
  stale. **Only a RECENT import_file job (`started_at >= cutoff`) counts as
  in-flight.** A live chunk refreshes `file_imports.updated_at` on every atomic
  checkpoint, so any queued/running job older than the cutoff is an orphan
  (classic case: a worker that died between the `jobs` INSERT and the queue
  send, leaving an undelivered `queued` row). Treating any queued row as active
  was the deadlock — it left imports `importing` forever.
- Before re-enqueue, demote stale orphan jobs (`started_at < cutoff`) to
  `status='failed'`. `enqueueImportResume` also demotes its own job on send
  failure. `import_attempts` resets to 0 on every progress checkpoint, so a
  healthy large import never trips `MAX_WATCHDOG_RECOVERIES`; true no-progress
  loops converge to terminal `status='error'`.
- **Terminal-state guard at processor entry:** bail if `status` is `done`/`error`
  so a late-delivered/duplicate resume message can't flip a finished import back
  to `importing` and re-run all chunks. `/retry` flips status to `mapped` (off
  `error`) before enqueue, so the guard doesn't block legitimate retries.
