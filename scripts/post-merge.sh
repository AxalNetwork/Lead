#!/bin/bash
# Post-merge setup for AI Data Signal monorepo.
# Idempotent — safe to re-run after every task merge.
set -euo pipefail

echo "[post-merge] installing root npm deps (worker bundle)"
npm install --no-audit --no-fund --prefer-offline

if [ -f apps/worker/package.json ]; then
  echo "[post-merge] installing apps/worker npm deps"
  npm install --prefix apps/worker --no-audit --no-fund --prefer-offline
fi

if [ -f apps/site/Gemfile ]; then
  echo "[post-merge] installing apps/site bundler gems"
  (cd apps/site && bundle install --quiet) || echo "[post-merge] bundle install failed (non-fatal)"
fi

echo "[post-merge] done"
