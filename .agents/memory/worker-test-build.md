---
name: worker test-build quirk
description: How apps/worker's test build (tsconfig.test.json) differs from production, and the extensionless-dynamic-import error class.
---

# apps/worker test build vs production typecheck

The worker has two TypeScript configs that resolve modules differently:

- **Production** (`apps/worker/tsconfig.json`): `module: ES2022`,
  `moduleResolution: Bundler`. Extensionless relative imports (static AND
  dynamic `await import("./x")`) are correct here. This is the build that
  actually ships, and it should be clean.
- **Test** (`apps/worker/tsconfig.test.json`): extends the above but forces
  `module/moduleResolution: NodeNext`, emits to `test-dist/`, and uses an
  **explicit `include` allow-list** of source files (NOT a glob over `src`).

**Why this matters / how to apply:**
- When you add a new source file that a `.mjs` test needs, you MUST add it to
  the `include` array in `tsconfig.test.json` or it won't be compiled into
  `test-dist/`.
- NodeNext flags extensionless relative imports as **TS2835** ("needs explicit
  file extensions"). The repo's dynamic-import convention is extensionless
  (used pervasively in `scheduled.ts`, plus `entities/facts.ts` and
  `entities/roles.ts`), so this error is **expected test-build noise**, not a
  real defect — production (Bundler) compiles them fine. Don't "fix" it by
  adding `.js` to one file; that diverges from the codebase convention.
- The test build has a handful of pre-existing errors (the TS2835 ones plus a
  few `null`-return TS2322/TS18047 in deals/fund/lp/secEdgar resolvers). They
  are tolerated; `tsc -p tsconfig.test.json` exits non-zero but still emits, so
  run it ignoring exit code, then `node --test test/<file>.test.mjs`.
- Tests live in `test/*.test.mjs` (hand-written, not compiled — rootDir is
  `src`) and import the compiled output from `../test-dist/...`.
