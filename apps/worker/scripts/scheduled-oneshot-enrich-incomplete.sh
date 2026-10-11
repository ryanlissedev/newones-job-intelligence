#!/usr/bin/env bash
# Coolify Scheduled Task wrapper (poller app) around the enrich-incomplete
# oneshot. flock keeps overlapping ticks from running two batches at once
# (the Trigger task had queue concurrency 1). Payload comes from env:
# ENRICH_DRY_RUN (default true), ENRICH_BATCH_SIZE, ENRICH_ENABLE_LLM_RESIDUAL,
# ENRICH_APPLY_STORED_PROPOSALS, ENRICHMENT_DURABLE. See
# docs/runbooks/enrichment-schedule.md.
set -euo pipefail

LOCK_FILE="${ENRICH_ONESHOT_LOCK_FILE:-/tmp/oneshot-enrich-incomplete.lock}"
# The poller image lands the repo at /app; allow override for host checkouts.
REPO_ROOT="${ONESHOT_REPO_ROOT:-/app}"
ONESHOT_SCRIPT="${REPO_ROOT}/apps/worker/scripts/oneshot-enrich-incomplete.ts"

if ! command -v flock >/dev/null 2>&1; then
  echo '{"status":"failed","reason":"flock_unavailable"}' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo '{"status":"failed","reason":"bun_unavailable"}' >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  # Exit 0 so Coolify scheduled-task alerts stay quiet while a prior tick runs.
  printf '{"status":"skipped","reason":"lock_held","lockFile":"%s"}\n' "$LOCK_FILE"
  exit 0
fi

if [[ ! -f "$ONESHOT_SCRIPT" ]]; then
  printf '{"status":"failed","reason":"oneshot_script_missing","path":"%s"}\n' "$ONESHOT_SCRIPT" >&2
  exit 1
fi

exec bun "$ONESHOT_SCRIPT" "$@"
