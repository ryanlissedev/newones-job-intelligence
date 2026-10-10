#!/usr/bin/env bash
set -euo pipefail

volume_name="${POSTGRES_DATA_VOLUME:-catapulze-postgres-p0}"

if [[ ! "$volume_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "postgres volume: invalid POSTGRES_DATA_VOLUME '$volume_name'" >&2
  exit 1
fi

if docker volume inspect "$volume_name" >/dev/null 2>&1; then
  echo "postgres volume: '$volume_name' already exists"
  exit 0
fi

docker volume create "$volume_name" >/dev/null
echo "postgres volume: created external volume '$volume_name'"
