#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

compose_env_file="${COMPOSE_ENV_FILE:-.env.example}"
compose_project="${RESTORE_DRILL_PROJECT:-catapulze-restore-drill}"
source_volume="${POSTGRES_DATA_VOLUME:-catapulze-postgres-restore-src}"
restore_volume="${POSTGRES_RESTORE_VOLUME:-catapulze-postgres-restore-target}"
restore_port="${POSTGRES_RESTORE_PORT:-55432}"
export POSTGRES_HOST_PORT="${RESTORE_DRILL_SOURCE_PORT:-55431}"
export MINIO_API_PORT="${RESTORE_DRILL_MINIO_PORT:-59000}"
source_port="$POSTGRES_HOST_PORT"
restore_container="${POSTGRES_RESTORE_CONTAINER:-catapulze-postgres-restore-target}"
evidence_path="${RESTORE_EVIDENCE_PATH:-.artifacts/postgres-restore-evidence.json}"
# ADR-0017 §2: the drill fails hard above these thresholds; the numbers are the
# ADR's proposed RTO (2h) and RPO (15min) until owners accept or amend them.
max_rto_seconds="${RESTORE_DRILL_MAX_RTO_SECONDS:-7200}"
max_rpo_seconds="${RESTORE_DRILL_MAX_RPO_SECONDS:-900}"

compose=(docker compose -p "$compose_project" --env-file "$compose_env_file" -f docker-compose.yml -f docker-compose.backup.yml)

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "restore-drill: required command '$1' is missing" >&2
    exit 1
  fi
}

require_command docker
require_command bun

now_ms() {
  # BSD date (macOS) lacks %N and prints a literal "N"; fall back to seconds.
  local stamp
  stamp="$(date +%s%3N)"
  if [[ "$stamp" == *N ]]; then
    stamp="$(date +%s)000"
  fi
  printf '%s' "$stamp"
}

cleanup() {
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$restore_container" >/dev/null 2>&1 || true
  docker volume rm "$restore_volume" >/dev/null 2>&1 || true
}

trap cleanup EXIT

started_at_ms="$(now_ms)"
POSTGRES_DATA_VOLUME="$source_volume" bash tools/postgres/ensure-volume.sh
docker volume rm "$restore_volume" >/dev/null 2>&1 || true
docker volume create "$restore_volume" >/dev/null

echo "restore-drill: starting source postgres with WAL archive to MinIO"
POSTGRES_DATA_VOLUME="$source_volume" "${compose[@]}" up -d --build --wait postgres minio minio-init

inspect_template="{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}}{{end}}"
network_name="$(
  "${compose[@]}" ps -q postgres | xargs docker inspect -f "$inspect_template"
)"

pg_admin_user="${POSTGRES_ADMIN_USER:-ji_admin}"
pg_admin_password="${POSTGRES_ADMIN_PASSWORD:-ji_admin_local}"
pg_database="${POSTGRES_DB:-ji_test}"

wal_g_source() {
  "${compose[@]}" exec -T -u postgres \
    -e "PGUSER=${pg_admin_user}" \
    -e "PGPASSWORD=${pg_admin_password}" \
    -e "PGDATABASE=${pg_database}" \
    postgres wal-g "$@"
}

export MIGRATION_DATABASE_URL="postgresql://ji_migrator:ji_migrator_local@127.0.0.1:${source_port}/ji_test"
bun run db:migrate

marker_table="u10_restore_marker"
marker_value="restore-drill-$(date +%s)"

"${compose[@]}" exec -T postgres \
  psql -U ji_admin -d ji_test -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS ${marker_table} (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());" \
  -c "INSERT INTO ${marker_table} (marker) VALUES ('${marker_value}');" \
  -c "CHECKPOINT;"

echo "restore-drill: pushing base backup and archived WAL to off-site fixture bucket"
wal_g_source backup-push /var/lib/postgresql/data
wal_g_source backup-list

"${compose[@]}" exec -T postgres \
  psql -U ji_admin -d ji_test \
  -c "INSERT INTO ${marker_table} (marker) VALUES ('${marker_value}-after-backup');" \
  -c "SELECT pg_switch_wal(); CHECKPOINT;"

# ADR-0017 §2: last confirmed commit time on the source; the RPO observation
# is this minus the latest marker replayed on the target after restore.
source_marker_epoch="$(
  "${compose[@]}" exec -T postgres \
    psql -U ji_admin -d ji_test -Atqc \
    "SELECT extract(epoch from created_at)::bigint FROM ${marker_table} WHERE marker='${marker_value}-after-backup';"
)"

wal_g_source backup-push /var/lib/postgresql/data

latest_backup="$(
  wal_g_source backup-list | awk '/^base_/ { backup=$1 } END { print backup }'
)"

if [[ -z "$latest_backup" ]]; then
  echo "restore-drill: no wal-g backup found" >&2
  exit 1
fi

echo "restore-drill: restoring ${latest_backup} into isolated target on port ${restore_port}"
docker rm -f "$restore_container" >/dev/null 2>&1 || true

docker run -d --name "$restore_container" \
  --network "$network_name" \
  -e AWS_ACCESS_KEY_ID="${WALG_S3_ACCESS_KEY:-walg_local}" \
  -e AWS_SECRET_ACCESS_KEY="${WALG_S3_SECRET_KEY:-walg_local_secret}" \
  -e AWS_ENDPOINT=http://minio:9000 \
  -e AWS_REGION="${WALG_S3_REGION:-us-east-1}" \
  -e AWS_S3_FORCE_PATH_STYLE=true \
  -e WALG_S3_PREFIX="s3://${WALG_S3_BUCKET:-catapulze-pg-backup}/pg" \
  -e WALG_COMPRESSION_METHOD=brotli \
  -p "127.0.0.1:${restore_port}:5432" \
  -v "${restore_volume}:/var/lib/postgresql/data" \
  catapulze-postgres-walg:16 \
  sleep infinity >/dev/null

# ADR-0017 §2: RTO runs from backup-fetch until the integrity checks pass.
restore_started_at_ms="$(now_ms)"
docker exec -u postgres \
  -e "PGUSER=${pg_admin_user}" \
  -e "PGPASSWORD=${pg_admin_password}" \
  -e "PGDATABASE=${pg_database}" \
  "$restore_container" wal-g backup-fetch /var/lib/postgresql/data "$latest_backup"
docker exec "$restore_container" sh -ec "
  cat > /var/lib/postgresql/data/recovery.signal <<'EOF'
EOF
  cat >> /var/lib/postgresql/data/postgresql.auto.conf <<'EOF'
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_action = promote
EOF
  chown -R postgres:postgres /var/lib/postgresql/data
"

docker exec -d "$restore_container" gosu postgres postgres -D /var/lib/postgresql/data

for attempt in $(seq 1 90); do
  if docker exec "$restore_container" gosu postgres pg_isready -U ji_admin -d ji_test >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 90 ]]; then
    echo "restore-drill: target postgres failed to become ready" >&2
    docker logs "$restore_container" >&2 || true
    exit 1
  fi
  sleep 1
done

bash tools/postgres/integrity-checks.sh "$restore_container" "$marker_value"

finished_at_ms="$(now_ms)"
duration_ms="$((finished_at_ms - started_at_ms))"
rto_ms="$((finished_at_ms - restore_started_at_ms))"
target_marker_epoch="$(
  docker exec -e PGPASSWORD="${POSTGRES_ADMIN_PASSWORD:-ji_admin_local}" "$restore_container" \
    psql -U ji_admin -d ji_test -Atqc \
    "SELECT max(extract(epoch from created_at))::bigint FROM ${marker_table};"
)"
rpo_observed_seconds=$((source_marker_epoch - target_marker_epoch))
if [[ "$rpo_observed_seconds" -lt 0 ]]; then
  rpo_observed_seconds=0
fi
git_sha="$(git rev-parse HEAD)"
recovery_point="$(
  docker exec -e PGPASSWORD="${POSTGRES_ADMIN_PASSWORD:-ji_admin_local}" "$restore_container" \
    psql -U ji_admin -d ji_test -Atqc "SELECT pg_last_wal_replay_lsn();"
)"

write_evidence() {
  local result="$1"
  local breached_json="$2"
  mkdir -p "$(dirname "$evidence_path")"
  cat >"$evidence_path" <<EOF
{
  "schemaVersion": 1,
  "requirement": "AE9 / R21 / JI-037",
  "environment": "ci-isolated-minio-fixture",
  "composeProject": "${compose_project}",
  "gitSha": "${git_sha}",
  "sourceVolume": "${source_volume}",
  "restoreVolume": "${restore_volume}",
  "restorePort": ${restore_port},
  "backupName": "${latest_backup}",
  "recoveryPointLsn": "${recovery_point}",
  "durationMs": ${duration_ms},
  "rtoMs": ${rto_ms},
  "rpoObservedSeconds": ${rpo_observed_seconds},
  "thresholds": { "maxRtoSeconds": ${max_rto_seconds}, "maxRpoSeconds": ${max_rpo_seconds} },
  "breached": ${breached_json},
  "markerTable": "${marker_table}",
  "markerValue": "${marker_value}",
  "result": "${result}"
}
EOF
}

breached=()
if [[ "$rto_ms" -gt $((max_rto_seconds * 1000)) ]]; then
  breached+=("rto")
fi
if [[ "$rpo_observed_seconds" -gt "$max_rpo_seconds" ]]; then
  breached+=("rpo")
fi

if [[ "${#breached[@]}" -gt 0 ]]; then
  breached_json="$(printf '"%s",' "${breached[@]}")"
  write_evidence "fail" "[${breached_json%,}]"
  echo "restore-drill: FAILED rto=${rto_ms}ms rpo=${rpo_observed_seconds}s breached=${breached[*]}; evidence written to ${evidence_path}" >&2
  exit 1
fi

write_evidence "pass" "[]"
echo "restore-drill: passed in ${duration_ms}ms (rto=${rto_ms}ms rpo=${rpo_observed_seconds}s); evidence written to ${evidence_path}"
