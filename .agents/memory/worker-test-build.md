---
name: worker test build quirks
description: How apps/worker tests compile/run and why tsc errors don't always block them
---

# apps/worker test build

`npm test` = `tsc -p tsconfig.test.json && node --test <files>`. Two non-obvious facts:

- **tsconfig.test.json uses `moduleResolution: NodeNext`** while the main build
  (tsconfig.json) uses `Bundler`. NodeNext is far stricter: relative imports
  (including dynamic `import()`) must carry explicit `.js` extensions or you get
  TS2835. Code that compiles for wrangler/deploy can still fail the test build.

- **tsc emits JS despite type errors** (`noEmitOnError` is false). So when the
  test build has pre-existing type errors that block the `&&`, you can still
  verify your own work: run `npx tsc -p tsconfig.test.json` (ignore exit code),
  then `node --test test/<your>.test.mjs` directly against the emitted
  `test-dist/`. The `.mjs` tests import from `../test-dist/...`.

**Why:** the committed baseline test build has carried multiple type errors at
times (createEntity now returns `EntityRow | null` but several service callers
return null against non-null signatures; extensionless dynamic orchestrator
imports). These block `npm test` at the tsc step even though the runtime JS is
fine. Don't assume an unrelated tsc error is your regression — diff against the
committed baseline (`git show HEAD:path`) before owning it.
