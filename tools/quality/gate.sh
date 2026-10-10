#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The Stop hook (.claude/settings.json) runs `bun run gate` as a plain
# subprocess of the Claude Code harness, not the developer's interactive
# shell — it never inherits POSTGRES_* from direnv/shell rc files the way a
# terminal-run `bun run gate` does. `docker compose` already reads `.env`
# automatically for the same variables; do the same here so the migration
# and test phases below see the real local credentials instead of falling
# back to the `ji_admin`/... defaults baked into tools/postgres/*.ts. CI
# never has a `.env` file (it's gitignored), so this is a no-op there.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PATH="./node_modules/.bin:$PATH"

# Claude Stop / lefthook / bare `bun run gate` do not inherit interactive
# shell exports. Load unset POSTGRES_* from `.env` (else `.env.example`) so
# test-isolation matches the credentials Compose used to start Postgres.
# shellcheck disable=SC1091
source "$ROOT/tools/quality/load-compose-env.sh"

if [[ -z "${QLTY_JOBS:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    QLTY_JOBS=1
  else
    QLTY_JOBS=2
  fi
fi

run_phase() {
  local label="$1"
  shift

  # Print elapsed seconds per phase so any CI log or local run shows where
  # gate time goes without needing the performance artifact.
  local phase_started="$SECONDS"

  if [[ -n "${PERF_METRICS_DIR:-}" ]]; then
    bun scripts/performance/measure.ts \
      --label "$label" \
      --output-dir "$PERF_METRICS_DIR" \
      --run-kind "${PERF_RUN_KIND:-unknown}" \
      -- "$@"
  else
    "$@"
  fi

  echo "gate: phase '$label' took $((SECONDS - phase_started))s"
}

hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "$hooks_path" ]]; then
  echo "gate: core.hooksPath is set to '$hooks_path' (expected unset; run bun install / lefthook install)"
  exit 1
fi

echo "gate: ultracite check (all)"
run_phase ultracite ultracite check

if ! command -v qlty >/dev/null 2>&1; then
  echo "gate: qlty CLI is required; install it from https://docs.qlty.sh/cli/installation" >&2
  exit 1
fi

echo "gate: qlty check --all --jobs $QLTY_JOBS --no-upgrade-check --no-progress --no-formatters"
run_phase qlty bash tools/quality/run-qlty.sh check --all --jobs "$QLTY_JOBS" --no-upgrade-check --no-progress --no-formatters

echo "gate: check-types"
run_phase typecheck bun run check-types

echo "gate: Effect E2E scripts typecheck"
run_phase effect-e2e-typecheck bun run check-types:effect-e2e

echo "gate: backfill tools typecheck"
run_phase backfill-typecheck bun run check-types:backfill

# scripts/production lives outside apps/* and packages/*, so turbo never
# type-checks the release gate and Coolify driver; the specs alone let 28
# type errors through on 2026-09-11.
echo "gate: production scripts typecheck"
run_phase production-typecheck bun run check-types:production

echo "gate: performance scripts typecheck"
run_phase performance-typecheck bun run check-types:performance

echo "gate: CI metrics scripts typecheck"
run_phase ci-metrics-typecheck bun run check-types:ci-metrics

# Benchmarks live outside apps/* and packages/*, so turbo never type-checks them.
echo "gate: benchmarks typecheck"
run_phase benchmarks-typecheck bun run check-types:benchmarks

echo "gate: check-layering"
run_phase layering bun run check-layering

echo "gate: check-secrets"
run_phase secrets bun run check-secrets

# RJC-400: when a local Manticore is configured, prove bench tables are empty
# before the rest of the gate (relevance/bench hygiene). Skips if unset.
if [[ -n "${MANTICORE_URL:-}" ]]; then
  echo "gate: check:manticore-bench-empty"
  run_phase manticore-bench-empty bun run check:manticore-bench-empty
fi

# RJC-395: point the migration-upgrade suite (packages/db/src/migration-upgrade.spec.ts)
# at a dedicated database instead of letting it skip silently. Every merged
# migration between 0006 and 0010 passed CI without this suite ever running.
if [[ -z "${DATABASE_UPGRADE_TEST_URL:-}" ]]; then
  echo "gate: preparing migration-upgrade test database"
  migration_upgrade_db_result="$(bun tools/postgres/ensure-migration-upgrade-db.ts)"
  case "$migration_upgrade_db_result" in
    READY:*)
      # The script writes the full connection string (with password) to a
      # mode-0600 temp file and prints only the file path — never the URL
      # itself — so the password never appears in this (or any) log line.
      migration_upgrade_rest="${migration_upgrade_db_result#READY:}"
      migration_upgrade_db_name="${migration_upgrade_rest%%|*}"
      migration_upgrade_url_file="${migration_upgrade_rest#*|}"
      DATABASE_UPGRADE_TEST_URL="$(cat "$migration_upgrade_url_file")"
      export DATABASE_UPGRADE_TEST_URL
      rm -rf "$(dirname "$migration_upgrade_url_file")"
      export REQUIRE_DATABASE_UPGRADE_TESTS=1
      echo "gate: migration-upgrade suite will run against database '$migration_upgrade_db_name'"
      ;;
    FAIL:*)
      # Reached Postgres but hit a real error (wrong password, missing
      # CREATEDB, ...) — never treat this as a skip, in CI or on a laptop:
      # that would silently disable the suite exactly like RJC-395 did.
      echo "gate: migration-upgrade database setup failed: ${migration_upgrade_db_result#FAIL:}" >&2
      exit 1
      ;;
    SKIP:*)
      # In CI, an unreachable migration-upgrade database must fail loudly
      # rather than silently reproduce RJC-395 (the server itself being
      # down while DATABASE_TEST_URL still works would otherwise skip this
      # suite again with every other DB test still green). Only a laptop
      # without Postgres running at all gets the graceful skip.
      if [[ -n "${CI:-}" ]]; then
        echo "gate: migration-upgrade database unavailable in CI: ${migration_upgrade_db_result#SKIP:}" >&2
        exit 1
      fi
      echo "gate: ${migration_upgrade_db_result#SKIP:} — skipping the migration-upgrade suite"
      ;;
    *)
      echo "gate: unexpected ensure-migration-upgrade-db.ts output: $migration_upgrade_db_result" >&2
      exit 1
      ;;
  esac
fi

echo "gate: test"
test_command=(bun test --max-concurrency 2 --path-ignore-patterns '**/dist/**')
if [[ -n "${PERF_JUNIT_PATH:-}" ]]; then
  junit_stem="${PERF_JUNIT_PATH%.xml}"
  junit_path="${junit_stem}.attempt-${PERF_ATTEMPT:-1}.${PERF_RUN_KIND:-unknown}.xml"
  mkdir -p "$(dirname -- "$junit_path")"
  test_command+=(--reporter=junit --reporter-outfile "$junit_path")
fi
run_phase test env REQUIRE_DATABASE_TESTS=1 "${test_command[@]}"

echo "gate: check-production-compose-guard"
run_phase production-compose-guard bun run check:production-compose-guard

echo "gate: check-postgres-compose"
run_phase postgres-compose bun run check:postgres-compose

# CTP-611: fixture-only replay (no DB) diffed against the committed baseline
# in fixtures/field-coverage/baseline.json — sub-second, so it belongs in the
# gate rather than as a manual check.
echo "gate: check-field-coverage"
run_phase field-coverage bun run check:field-coverage

echo "gate: passed"
