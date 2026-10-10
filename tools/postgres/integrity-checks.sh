#!/usr/bin/env bash
set -euo pipefail

container_name="${1:?container name required}"
expected_marker="${2:?expected marker value required}"
database_user="${POSTGRES_ADMIN_USER:-ji_admin}"
database_name="${POSTGRES_DB:-ji_test}"
database_password="${POSTGRES_ADMIN_PASSWORD:-ji_admin_local}"

journal_count="$(
  docker exec -e PGPASSWORD="$database_password" "$container_name" \
    psql -U "$database_user" -d "$database_name" -Atqc "SELECT COUNT(*) FROM drizzle.__drizzle_migrations;"
)"
if [[ "$journal_count" -lt 1 ]]; then
  echo "integrity-checks: expected drizzle migration journal entries" >&2
  exit 1
fi

for relation in staging.source_record curated.bron curated.aanvraag; do
  docker exec -e PGPASSWORD="$database_password" "$container_name" \
    psql -U "$database_user" -d "$database_name" -Atqc "SELECT to_regclass('${relation}');" | grep -qx "${relation}" || {
    echo "integrity-checks: missing relation ${relation}" >&2
    exit 1
  }
done

marker_count="$(
  docker exec -e PGPASSWORD="$database_password" "$container_name" \
    psql -U "$database_user" -d "$database_name" -Atqc "SELECT COUNT(*) FROM u10_restore_marker WHERE marker = '${expected_marker}';"
)"
if [[ "$marker_count" != "1" ]]; then
  echo "integrity-checks: restore marker '${expected_marker}' not found" >&2
  exit 1
fi

echo "integrity-checks: migration journal, core relations, and restore marker verified"
