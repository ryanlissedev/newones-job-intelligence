#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker-compose smoke: docker is required" >&2
  exit 1
fi

# Prefer an explicit COMPOSE_ENV_FILE. Otherwise use a local `.env` when
# present; fall back to the committed disposable-smoke fixture so CI (and a
# clean checkout) does not depend on a gitignored file.
if [[ -n "${COMPOSE_ENV_FILE:-}" ]]; then
  compose_env_file="$COMPOSE_ENV_FILE"
elif [[ -f .env ]]; then
  compose_env_file=".env"
else
  compose_env_file="scripts/fixtures/docker-smoke.env"
fi
if [[ ! -f "$compose_env_file" ]]; then
  echo "docker-compose smoke: Compose env file '$compose_env_file' does not exist" >&2
  exit 1
fi
raw_storage_enabled="${SMOKE_RAW_STORAGE:-0}"
compose_parallel_limit="${COMPOSE_PARALLEL_LIMIT:-2}"
if [[ ! "$compose_parallel_limit" =~ ^[12]$ ]]; then
  echo "docker-compose smoke: COMPOSE_PARALLEL_LIMIT must be 1 or 2" >&2
  exit 1
fi
# Exported ambient variables win Compose interpolation over --env-file and
# silently override the chosen env file's contract (the Crabbox shadow lane
# proved this: its exported shadow credentials made postgres initialize
# ji_test while the host migrate targeted the fixture's ji_smoke). Scrub the
# environment the same way mcp-edge-smoke.sh does so the env file stays
# authoritative for every caller.
compose_command=(
  env -i
  "HOME=$HOME"
  "PATH=$PATH"
  "COMPOSE_PARALLEL_LIMIT=$compose_parallel_limit"
)
# Docker client transport selection is the caller's daemon choice, not
# Compose interpolation: keep it so every invocation targets the same
# daemon as the raw `docker volume` calls in ensure-volume.sh.
for docker_var in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH; do
  if [[ -n "${!docker_var:-}" ]]; then
    compose_command+=("$docker_var=${!docker_var}")
  fi
done
# The 1Password lane (env-file entries like `NAME=op://vault/item/field`)
# resolves secrets through `op run`, which injects them via the process
# environment — the one ambient source Compose must still see. Forward
# exactly the names the env file marks as op:// references; every other
# name keeps the env file authoritative.
while IFS='=' read -r env_name env_value; do
  if [[ ! "$env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || "$env_value" != *op://* ]]; then
    continue
  fi
  if [[ -n "${!env_name:-}" ]]; then
    compose_command+=("$env_name=${!env_name}")
  fi
done < "$compose_env_file"
compose_command+=(
  docker compose --env-file "$compose_env_file"
)
compose_profiles=(--profile projector)
diagnostic_services=(server projector)
if [[ "$raw_storage_enabled" == "1" ]]; then
  if [[ ! -f docker-compose.smoke.yml ]]; then
    echo "docker-compose smoke: docker-compose.smoke.yml is required when SMOKE_RAW_STORAGE=1" >&2
    exit 1
  fi
  # The override injects the synthetic MinIO S3 settings into the server only
  # for this explicitly opted-in smoke lane. The base Compose file keeps its
  # normal filesystem fallback and production deployment contract.
  # Merge order: base Compose file first, then the smoke override.
  compose_command+=(--file docker-compose.yml --file docker-compose.smoke.yml)
  compose_profiles+=(--profile storage)
  diagnostic_services+=(raw-storage-minio raw-storage-minio-init)
fi
if [[ ! -f apps/server/.env && -z "${MIGRATION_DATABASE_URL:-}" ]]; then
  echo "docker-compose smoke: provide apps/server/.env or inject MIGRATION_DATABASE_URL" >&2
  exit 1
fi
if [[ -n "$("${compose_command[@]}" ps -aq)" ]]; then
  echo "docker-compose smoke: stop the existing Compose stack before running this isolated test" >&2
  exit 1
fi

volume_name="$({
  "${compose_command[@]}" config --format json
} | bun -e 'const config = JSON.parse(await Bun.stdin.text()); process.stdout.write(config.volumes.postgres_data.name);')"
POSTGRES_DATA_VOLUME="$volume_name" bash tools/postgres/ensure-volume.sh

cleanup() {
  local exit_status=$?
  local cleanup_status=0
  if ((exit_status != 0)); then
    echo "docker-compose smoke: collecting failure diagnostics (exit $exit_status)" >&2
    "${compose_command[@]}" ps >&2 || true
    "${compose_command[@]}" logs --no-color --tail 80 "${diagnostic_services[@]}" >&2 || true
  fi
  "${compose_command[@]}" "${compose_profiles[@]}" down || cleanup_status=$?
  if ((exit_status != 0)); then
    return "$exit_status"
  fi
  return "$cleanup_status"
}
trap cleanup EXIT

"${compose_command[@]}" --profile projector build
"${compose_command[@]}" up -d --wait postgres manticore redis
if [[ "$raw_storage_enabled" == "1" ]]; then
  # Start MinIO and wait for its healthcheck, then run the one-shot bucket
  # bootstrap to completion before any server readiness check can run.
  "${compose_command[@]}" --profile storage up -d --wait raw-storage-minio
  "${compose_command[@]}" --profile storage run --rm --no-deps raw-storage-minio-init
fi
bun run db:migrate

# A persistent Postgres volume can carry a checkpoint from an older search
# mapping. The server healthcheck deliberately uses /readyz, so starting the
# normal app stack first would deadlock on that mismatch: server stays
# unhealthy, web waits for server, and the replay command never gets a chance
# to run. Bootstrap the durable generation through the built server image on
# the Compose network while the API is still stopped.
"${compose_command[@]}" run --rm --no-deps server \
  bun /app/tools/manticore/start-search-generation.ts --apply

# The projector is opt-in in docker-compose.yml. Start it only after the
# generation is finalized, then start the healthchecked app services. This
# drains the replay before reconciliation and keeps the default Compose
# semantics unchanged for normal local development.
"${compose_command[@]}" --profile projector up -d --no-build projector
"${compose_command[@]}" up -d --no-build --wait server web

wait_for_projection_drain() {
  local readiness_attempts=60
  local readiness_body
  for ((attempt = 1; attempt <= readiness_attempts; attempt += 1)); do
    readiness_body="$(curl --silent --show-error --max-time 5 http://localhost:3000/readyz 2>/dev/null || true)"
    if [[ -n "$readiness_body" ]] && bun -e '
      const report = JSON.parse(await Bun.stdin.text());
      const projection = report.components?.searchProjection;
      process.exit(
        projection?.status === "ok" && projection.lagEvents === 0 ? 0 : 1
      );
    ' <<<"$readiness_body"; then
      return 0
    fi
    sleep 2
  done
  echo "docker-compose smoke: search projection did not drain within 120 seconds" >&2
  return 1
}

wait_for_projection_drain

# Reconciliation is report-only here, but it must run after the replay drain
# and with the projector stopped so the inventory cannot change underneath the
# scan. A non-zero result still fails the smoke via the command's own guards.
"${compose_command[@]}" --profile projector stop projector
"${compose_command[@]}" run --rm --no-deps server \
  bun /app/tools/search/reconcile-projection.ts --fail-on-drift

curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3000/readyz >/dev/null
curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3001/ >/dev/null
# The SSR session lookup on /dashboard leaves the web container over
# INTERNAL_SERVER_URL; without it every /dashboard was a 500 (ECONNREFUSED
# 127.0.0.1:3000) while "/" stayed green. Assert the logged-out redirect.
dashboard_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://localhost:3001/dashboard)"
if [[ "$dashboard_status" != "307" ]]; then
  echo "docker-compose smoke: GET /dashboard returned $dashboard_status, expected 307 to /login (check INTERNAL_SERVER_URL on web)" >&2
  exit 1
fi
echo "docker-compose smoke: postgres, server and web are healthy"

# RJC-356: exercise the live Manticore document-id integration test now that
# a real Manticore instance is up as part of this stack. This script never
# sources the compose env file into the shell, so ${MANTICORE_HTTP_PORT}
# could disagree with the port compose actually published — ask compose for
# the real published address instead of assuming the default.
#
# Host `bun test` preloads tools/postgres/test-isolation.ts, which would
# otherwise probe Postgres with .env.example defaults (ji_admin_local)
# against the smoke fixture roles (ji_admin_smoke) and fail auth. This live
# suite only needs Manticore — short-circuit isolation the same way the
# pre-#165 in-container invocation did with an unreachable DATABASE_TEST_URL.
#
# CTP-604: all five live spec files run here, not just live.spec.ts. #316 gave
# each live spec its own Manticore tables, and seven of the eight live tests
# had no CI coverage against those per-file names. A table missing from a conf
# or from a stale searchd therefore went unnoticed until someone ran the live
# suite by hand.
live_search_specs=(
  packages/search/src/adapter.spec.ts
  packages/search/src/ast-hash.spec.ts
  packages/search/src/manticore/bulk-live.spec.ts
  packages/search/src/manticore/live.spec.ts
  packages/search/src/manticore/sort-live.spec.ts
)
manticore_address="$("${compose_command[@]}" port manticore 9308)"
DATABASE_TEST_URL="postgresql://smoke:smoke@127.0.0.1:1/unreachable" \
  MANTICORE_URL="http://${manticore_address}" \
  MANTICORE_REQUIRE_LIVE=1 \
  bun test "${live_search_specs[@]}"
echo "docker-compose smoke: Manticore live search suite passed"
