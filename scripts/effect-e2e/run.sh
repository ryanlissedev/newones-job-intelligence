#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly repo_root
compose_file="$repo_root/docker-compose.effect-e2e.yml"
readonly compose_file
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
run_id="$(printf '%s' "$run_id" | tr '[:upper:]' '[:lower:]')"
readonly run_id
evidence_dir="$repo_root/.artifacts/effect-e2e/$run_id"
readonly evidence_dir
private_dir="$(mktemp -d "${TMPDIR:-/tmp}/ji-effect-e2e.$run_id.XXXXXX")"
readonly private_dir
readonly compose_env="$private_dir/compose.env"
readonly private_env="$private_dir/effect.env"
readonly full_failure_log="$private_dir/compose.log"
readonly perf_dir="$evidence_dir/perf"
readonly raw_dir="$evidence_dir/raw"
readonly project_name="ji-effect-e2e-$run_id"

mkdir -p "$evidence_dir" "$perf_dir" "$raw_dir"
chmod 700 "$private_dir" "$evidence_dir"
# Docker Desktop may map the image's non-root `bun` user to a different host
# UID. These run-local mounts contain synthetic records only, never auth state.
chmod 777 "$perf_dir" "$raw_dir"

compose() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$compose_env" \
    --file "$compose_file" \
    "$@"
}

port_is_free() {
  python3 - "$1" <<'PY'
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
    except OSError:
        raise SystemExit(1)
PY
}

allocate_port() {
  local preferred="$1"
  shift
  local used_port
  for used_port in "$@"; do
    if [[ "$preferred" == "$used_port" ]]; then
      preferred=""
      break
    fi
  done
  if [[ -n "$preferred" ]] && port_is_free "$preferred"; then
    printf '%s\n' "$preferred"
    return 0
  fi
  for _ in {1..20}; do
    candidate="$(python3 - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
    local already_used=0
    for used_port in "$@"; do
      if [[ "$candidate" == "$used_port" ]]; then
        already_used=1
        break
      fi
    done
    if ((already_used == 0)) && port_is_free "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "effect-e2e: could not allocate a free loopback port" >&2
  return 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "effect-e2e: $1 is required" >&2
    exit 1
  fi
}

sanitize_log() {
  local source_path="$1"
  local destination_path="$2"
  if [[ ! -f "$source_path" ]]; then
    return 0
  fi
  sed -E \
    -e 's#(postgres(ql)?://[^:]+:)[^@/]+@#\1<redacted>@#g' \
    -e 's#(AUTH_BOOTSTRAP_PASSWORD=)[^[:space:]]+#\1<redacted>#g' \
    -e 's#(BETTER_AUTH_SECRET=)[^[:space:]]+#\1<redacted>#g' \
    "$source_path" >"$destination_path" || true
}

sanitize_failure_log() {
  sanitize_log "$full_failure_log" "$evidence_dir/failure.log"
}

cleanup() {
  local exit_status=$?
  local down_status=0
  if ((exit_status != 0)); then
    if [[ -f "$compose_env" ]]; then
      compose ps >"$private_dir/compose-ps.txt" 2>&1 || true
      compose logs --no-color >"$full_failure_log" 2>&1 || true
      cat "$private_dir/compose-ps.txt" >&2 || true
      sanitize_failure_log
    fi
  fi
  if [[ -f "$compose_env" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || down_status=$?
  fi
  rm -rf "$private_dir"
  if ((exit_status != 0)); then
    exit "$exit_status"
  fi
  exit "$down_status"
}
trap cleanup EXIT

require_command docker
require_command bun
require_command python3

if [[ ! -f "$compose_file" ]]; then
  echo "effect-e2e: compose file is missing: $compose_file" >&2
  exit 1
fi
if [[ ! -f "$repo_root/scripts/effect-e2e/seed.ts" || ! -f "$repo_root/scripts/effect-e2e/check.ts" ]]; then
  echo "effect-e2e: seed.ts and check.ts must be integrated before running the lane" >&2
  exit 1
fi

expected_sha="${EFFECT_E2E_EXPECTED_SHA:-}"
git_head=""
if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_head="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "$expected_sha" ]]; then
  expected_sha="$git_head"
fi
if [[ -z "$expected_sha" ]]; then
  echo "effect-e2e: set EFFECT_E2E_EXPECTED_SHA when the workspace has no git metadata" >&2
  exit 1
fi
if [[ -n "$git_head" && "$expected_sha" != "$git_head" ]]; then
  echo "effect-e2e: EFFECT_E2E_EXPECTED_SHA must match Git HEAD when Git metadata is available" >&2
  exit 1
fi
readonly expected_sha
readonly image_prefix="ji-effect-e2e-${expected_sha:0:12}"
dirty=0
if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=all 2>/dev/null)" ]]; then
    dirty=1
  fi
else
  # A transferred snapshot deliberately omits .git and cannot prove clean state.
  dirty=1
fi
if [[ "${EFFECT_E2E_SKIP_BUILD:-0}" == "1" && "$dirty" != "0" ]]; then
  echo "effect-e2e: refusing EFFECT_E2E_SKIP_BUILD=1 for a dirty or unbound workspace; rebuild required" >&2
  exit 1
fi

postgres_port="$(allocate_port 5432)"
readonly postgres_port
redis_port="$(allocate_port 6379 "$postgres_port")"
readonly redis_port
manticore_http_port="$(allocate_port 9308 "$postgres_port" "$redis_port")"
readonly manticore_http_port
manticore_mysql_port="$(allocate_port 9306 "$postgres_port" "$redis_port" "$manticore_http_port")"
readonly manticore_mysql_port
server_port="$(allocate_port "${EFFECT_E2E_SERVER_PORT:-3000}" "$postgres_port" "$redis_port" "$manticore_http_port" "$manticore_mysql_port")"
readonly server_port
web_port="$(allocate_port "${EFFECT_E2E_WEB_PORT:-3001}" "$postgres_port" "$redis_port" "$manticore_http_port" "$manticore_mysql_port" "$server_port")"
readonly web_port
readonly api_url="http://127.0.0.1:$server_port"
readonly web_url="http://127.0.0.1:$web_port"
readonly database_name="ji_effect_e2e"
canary_id="$(bun -e 'console.log(crypto.randomUUID())')"
readonly canary_id
canary_digest="$(printf '%s' "$canary_id" | shasum -a 256 | awk '{print $1}')"
readonly canary_digest
readonly db_marker="effect-e2e-$run_id-${canary_id:0:12}"
readonly auth_email="effect-e2e-${run_id}@example.invalid"
readonly auth_password="effect-e2e-${run_id}-synthetic-password"
readonly auth_secret="effect-e2e-${run_id}-synthetic-auth-secret-32-chars"

cat >"$compose_env" <<EOF
EFFECT_E2E_PROJECT_NAME=$project_name
EFFECT_E2E_POSTGRES_PORT=$postgres_port
EFFECT_E2E_REDIS_PORT=$redis_port
EFFECT_E2E_MANTICORE_HTTP_PORT=$manticore_http_port
EFFECT_E2E_MANTICORE_MYSQL_PORT=$manticore_mysql_port
EFFECT_E2E_SERVER_PORT=$server_port
EFFECT_E2E_WEB_PORT=$web_port
EFFECT_E2E_API_URL=$api_url
EFFECT_E2E_WEB_URL=$web_url
EFFECT_E2E_EXPECTED_SHA=$expected_sha
EFFECT_E2E_ADMIN_USER=ji_effect_admin
EFFECT_E2E_ADMIN_PASSWORD=effect_admin_$run_id
EFFECT_E2E_DB_NAME=$database_name
EFFECT_E2E_MIGRATOR_USER=ji_effect_migrator
EFFECT_E2E_MIGRATOR_PASSWORD=effect_migrator_$run_id
EFFECT_E2E_APP_USER=ji_effect_app
EFFECT_E2E_APP_PASSWORD=effect_app_$run_id
EFFECT_E2E_AUTH_SECRET=$auth_secret
EFFECT_E2E_AUTH_EMAIL=$auth_email
EFFECT_E2E_AUTH_PASSWORD=$auth_password
EFFECT_E2E_CONTAINER_DATABASE_URL=postgresql://ji_effect_app:effect_app_$run_id@postgres:5432/$database_name
EFFECT_E2E_CONTAINER_MIGRATION_DATABASE_URL=postgresql://ji_effect_migrator:effect_migrator_$run_id@postgres:5432/$database_name
EFFECT_E2E_PERF_DIR=$perf_dir
EFFECT_E2E_RAW_DIR=$raw_dir
EFFECT_E2E_IMAGE_PREFIX=$image_prefix
EOF

cat >"$private_env" <<EOF
export EFFECT_E2E_API_URL=$api_url
export EFFECT_E2E_WEB_URL=$web_url
export EFFECT_E2E_BASE_URL=$web_url
export EFFECT_E2E_DATABASE_URL=postgresql://ji_effect_app:effect_app_$run_id@127.0.0.1:$postgres_port/$database_name
export EFFECT_E2E_MIGRATION_DATABASE_URL=postgresql://ji_effect_migrator:effect_migrator_$run_id@127.0.0.1:$postgres_port/$database_name
export EFFECT_E2E_EXPECTED_SHA=$expected_sha
export EFFECT_E2E_DIRTY=$dirty
export EFFECT_E2E_DISPOSABLE_DB=1
export EFFECT_E2E_DATABASE_NAME=$database_name
export EFFECT_E2E_DB_MARKER=$db_marker
export EFFECT_E2E_SYNTHETIC=1
export JI_EFFECT_SEARCH=1
export JI_EFFECT_DB=1
export JI_EFFECT_SERVER=1
export JI_EFFECT_WORKER=1
export PERF_EFFECT_SPANS=1
export EFFECT_E2E_ARTIFACT_DIR=$evidence_dir
export EFFECT_E2E_PRIVATE_DIR=$private_dir
export EFFECT_E2E_CANARY_ID=$canary_id
export EFFECT_E2E_CANARY_DIGEST=$canary_digest
export EFFECT_E2E_AUTH_EMAIL=$auth_email
export EFFECT_E2E_AUTH_PASSWORD=$auth_password
export EFFECT_E2E_AUTH_SECRET=$auth_secret
export EFFECT_E2E_AUTH_FILE=$private_dir/auth.json
export EFFECT_E2E_STORAGE_STATE=$private_dir/storage-state.json
export BETTER_AUTH_SECRET=$auth_secret
export BETTER_AUTH_URL=$api_url
export CORS_ORIGIN=$web_url
export EFFECT_E2E_QUERY=EFFECTE2E${canary_id:0:8}
EOF
chmod 600 "$compose_env" "$private_env"

echo "effect-e2e: run $run_id sha $expected_sha dirty $dirty"
echo "effect-e2e: api $api_url web $web_url"

if [[ "${EFFECT_E2E_SKIP_BUILD:-0}" == "1" ]]; then
  echo "effect-e2e: reusing the existing run-local images"
else
  compose build migrate server web projector worker
fi
compose up -d --wait postgres redis manticore
compose up --no-build migrate
compose run --rm --no-deps server bun /app/tools/manticore/start-search-generation.ts --apply >"$private_dir/generation.log" 2>&1
compose up -d --wait server web
compose exec -T server bun -e '
  const names = ["JI_EFFECT_SEARCH", "JI_EFFECT_DB", "JI_EFFECT_SERVER", "JI_EFFECT_WORKER", "PERF_EFFECT_SPANS"];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  if (names.some((name) => values[name] !== "1")) process.exit(1);
  console.log(JSON.stringify({ process: "server", flags: values }));
' >"$evidence_dir/runtime-flags.json"

set +u
# shellcheck disable=SC1090
source "$private_env"
set -u

if ! curl --fail --silent --show-error --retry 20 --retry-delay 1 "$EFFECT_E2E_API_URL/readyz" >"$private_dir/readyz.json"; then
  echo "effect-e2e: /readyz did not become available" >&2
  exit 1
fi

bun "$repo_root/scripts/effect-e2e/seed.ts" >"$private_dir/seed.log" 2>&1 || {
  sanitize_log "$private_dir/seed.log" "$evidence_dir/seed-failure.log"
  cat "$evidence_dir/seed-failure.log" >&2 || true
  exit 1
}

worker_artifact="$evidence_dir/worker-task-body.json"
outbox_id="$(EFFECT_E2E_SEED_PATH="$evidence_dir/seed.json" bun -e 'const seed = await Bun.file(process.env.EFFECT_E2E_SEED_PATH).json(); console.log(seed.cleanup.outboxId)')"
if ! compose run --rm --no-deps \
  -e EFFECT_E2E_WORKER_ARTIFACT=/tmp/effect-e2e-worker.json \
  -e EFFECT_E2E_EXPECTED_CANARY_ID="$outbox_id" \
  worker bun /app/scripts/effect-e2e/run-worker.ts >"$private_dir/worker.log" 2>&1; then
  sanitize_log "$private_dir/worker.log" "$evidence_dir/worker-failure.log"
  echo "effect-e2e: bounded worker task-body probe failed" >&2
  exit 2
fi
if ! rg -q '"durability":"not-proven-trigger"' "$private_dir/worker.log" || \
  ! rg -q '"effectWorkerFlag":true' "$private_dir/worker.log" || \
  ! rg -q '"drained":[1-9]' "$private_dir/worker.log" || \
  ! rg -q "$outbox_id" "$private_dir/worker.log"; then
  echo "effect-e2e: worker probe did not process the seeded canary with the durability boundary" >&2
  exit 2
fi
printf '%s\n' "$(tail -n 1 "$private_dir/worker.log")" >"$worker_artifact"

compose up -d --wait projector
compose exec -T projector bun -e '
  const names = ["JI_EFFECT_SEARCH", "JI_EFFECT_DB", "JI_EFFECT_SERVER", "JI_EFFECT_WORKER", "PERF_EFFECT_SPANS"];
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  if (names.some((name) => values[name] !== "1")) process.exit(1);
  console.log(JSON.stringify({ process: "projector", flags: values }));
' >"$evidence_dir/runtime-flags-projector.json"

bun "$repo_root/scripts/effect-e2e/check.ts" >"$private_dir/check.log" 2>&1 || {
  sanitize_log "$private_dir/check.log" "$evidence_dir/check-failure.log"
  cat "$evidence_dir/check-failure.log" >&2 || true
  exit 1
}

perf_count="$(find "$perf_dir" -type f -name '*.json' -print | wc -l | tr -d ' ')"
if [[ "$perf_count" == "0" ]]; then
  echo '{"status":"NOT_VERIFIED","reason":"no critical-path performance records were emitted"}' >"$evidence_dir/perf-check.json"
  echo "effect-e2e: no perf records were emitted" >&2
  exit 2
fi
printf '{"status":"PARTIAL","records":%s,"effectSpanExport":"not-observable-from-record-file"}\n' "$perf_count" >"$evidence_dir/perf-check.json"

cat >"$evidence_dir/run.json" <<EOF
{
  "schemaVersion": 1,
  "runId": "$run_id",
  "projectName": "$project_name",
  "git": {"sha": "$expected_sha", "dirty": $([[ "$dirty" == "1" ]] && echo true || echo false)},
  "flags": {
    "JI_EFFECT_SEARCH": "1",
    "JI_EFFECT_DB": "1",
    "JI_EFFECT_SERVER": "1",
    "JI_EFFECT_WORKER": "1",
    "PERF_EFFECT_SPANS": "1"
  },
  "worker": {"durability": "not-proven-trigger", "status": "bounded-task-body-probed"},
  "performance": {"records": $perf_count, "effectSpanExport": "not-observable-from-record-file"}
}
EOF

echo "effect-e2e: passed primary lane; worker Trigger durability and Effect span export remain explicitly unproven"
