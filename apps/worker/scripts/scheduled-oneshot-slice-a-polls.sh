#!/usr/bin/env bash
# CTP-489 — Coolify / host-cron wrapper around oneshot Slice A polls.
# flock prevents overlapping ticks from double-polling the same Slice A set.
# Not a permanent Trigger replacement. Motian untouched. LLM OFF.
set -euo pipefail

LOCK_FILE="${ONESHOT_SLICE_A_LOCK_FILE:-/tmp/oneshot-slice-a-polls.lock}"
# Coolify server image lands the repo at /app; allow override for host checkouts.
REPO_ROOT="${ONESHOT_REPO_ROOT:-/app}"
ONESHOT_SCRIPT="${REPO_ROOT}/apps/worker/scripts/oneshot-slice-a-polls.ts"

if ! command -v flock >/dev/null 2>&1; then
  echo '{"status":"failed","reason":"flock_unavailable","hint":"install util-linux flock on the Coolify host/container"}' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo '{"status":"failed","reason":"bun_unavailable"}' >&2
  exit 1
fi

# FD 9 holds the lock for the lifetime of this process.
# Acquire before other fail-closed checks so overlapping ticks still skip cleanly.
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

started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"status":"starting","lockFile":"%s","startedAt":"%s"}\n' "$LOCK_FILE" "$started_at"

set +e
# Default cadence target: full pollable Slice A fan-out. Extra args (e.g. --limit)
# are forwarded after --bron all for ops overrides.
bun "$ONESHOT_SCRIPT" --run --bron all "$@"
exit_code=$?
set -e

finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '{"status":"finished","exitCode":%s,"finishedAt":"%s","startedAt":"%s"}\n' \
  "$exit_code" "$finished_at" "$started_at"
exit "$exit_code"
