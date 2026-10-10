#!/usr/bin/env bash
# CI only: route anonymous Docker Hub pulls on a GitHub-hosted runner through
# Google's no-login pull-through cache (mirror.gcr.io). Shared runner IPs hit
# Docker Hub's unauthenticated pull rate limit (HTTP 429), which failed the
# image-pulling jobs. A daemon-level registry mirror covers `docker compose
# pull/up`, `docker run` and Dockerfile `FROM` lines without changing any
# image reference, so the production Dockerfiles and compose files stay
# byte-for-byte the same. Digest-pinned references resolve to the same
# content; when the mirror misses, dockerd falls back to Docker Hub.
set -euo pipefail

mirror="${DOCKER_HUB_MIRROR:-https://mirror.gcr.io}"
daemon_json=/etc/docker/daemon.json

current='{}'
if [[ -s "$daemon_json" ]]; then
  current="$(sudo cat "$daemon_json")"
fi

updated="$(jq --arg mirror "$mirror" \
  '."registry-mirrors" = ((."registry-mirrors" // []) + [$mirror] | unique)' \
  <<<"$current")"
printf '%s\n' "$updated" | sudo tee "$daemon_json" >/dev/null

sudo systemctl restart docker
for _ in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -q "${mirror#https://}"; then
  echo "ci-docker-hub-mirror: dockerd did not pick up $mirror" >&2
  exit 1
fi
echo "ci-docker-hub-mirror: Docker Hub pulls go through $mirror"
