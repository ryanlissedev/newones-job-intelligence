#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "MCP edge smoke: docker is required" >&2
  exit 1
fi

compose_env_file="scripts/fixtures/docker-smoke.env"
run_id="${GITHUB_RUN_ID:-local}"
run_attempt="${GITHUB_RUN_ATTEMPT:-local}"
project_name="catapulze-edge-${run_id//[^a-zA-Z0-9_-]/-}-${run_attempt//[^a-zA-Z0-9_-]/-}-$$"
artifact_dir="${MCP_EDGE_ARTIFACT_DIR:-.artifacts/mcp-edge-smoke}"
compose_parallel_limit="${COMPOSE_PARALLEL_LIMIT:-2}"
source_sha="$(git rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$source_sha" ]]; then
  source_sha="${CRABBOX_SOURCE_GIT_SHA:-}"
fi
pr_head_sha="${MCP_EDGE_PR_HEAD_SHA:-$source_sha}"

if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ || ! "$pr_head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "MCP edge smoke: source identities must be full Git SHAs" >&2
  exit 1
fi

if [[ ! "$compose_parallel_limit" =~ ^[12]$ ]]; then
  echo "MCP edge smoke: COMPOSE_PARALLEL_LIMIT must be 1 or 2" >&2
  exit 1
fi

mkdir -p "$artifact_dir"
route_config_sha="$(shasum -a 256 scripts/mcp-edge-nginx.conf | awk '{print $1}')"
cp scripts/mcp-edge-nginx.conf "$artifact_dir/route-config.conf"
jq -n \
  --arg prHeadSha "$pr_head_sha" \
  --arg routeConfigSha "$route_config_sha" \
  --arg testedSha "$source_sha" \
  '{prHeadSha: $prHeadSha, routeConfigSha: $routeConfigSha, testedSha: $testedSha}' \
  >"$artifact_dir/runtime-identity.json"
compose_command=(
  env -i
  "HOME=$HOME"
  "PATH=$PATH"
  "COMPOSE_PARALLEL_LIMIT=$compose_parallel_limit"
  "MCP_EDGE_SOURCE_SHA=$source_sha"
  docker compose
  --project-name "$project_name"
  --env-file "$compose_env_file"
  --file docker-compose.yml
  --file docker-compose.mcp-edge-smoke.yml
  --profile storage
  --profile projector
  --profile mcp-edge
)

if [[ -n "${MCP_EDGE_CONFIG_OUTPUT:-}" ]]; then
  "${compose_command[@]}" config --format json >"$MCP_EDGE_CONFIG_OUTPUT"
  exit 0
fi

cleanup() {
  local status="$?"
  local down_status
  set +e
  "${compose_command[@]}" ps --all \
    --format '{{.Service}} {{.State}} {{.Health}}' \
    >"$artifact_dir/container-status.txt" 2>/dev/null
  "${compose_command[@]}" down --volumes --remove-orphans
  down_status="$?"
  trap - EXIT
  if ((status == 0 && down_status != 0)); then
    status="$down_status"
    echo "MCP edge smoke: cleanup failed" >&2
  elif ((status != 0)); then
    echo "MCP edge smoke: failed" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose_command[@]}" config --quiet
"${compose_command[@]}" build server-a migrator projector
"${compose_command[@]}" pull edge
"${compose_command[@]}" up -d --wait postgres redis manticore raw-storage-minio
"${compose_command[@]}" run --rm migrator
"${compose_command[@]}" up -d --no-build --wait raw-storage-minio-init projector server-a server-b edge
runtime_route_config_sha="$(
  "${compose_command[@]}" exec -T edge sha256sum /etc/nginx/nginx.conf | awk '{print $1}'
)"
if [[ "$runtime_route_config_sha" != "$route_config_sha" ]]; then
  echo "MCP edge smoke: proxy route configuration readback differs" >&2
  exit 1
fi

"${compose_command[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U ji_admin -d ji_smoke <<'SQL'
INSERT INTO curated.bron (
  id, naam, categorie, ingestie_type, interval, rate_limit_per_minute,
  crawl_delay_ms, status, voorwaarden_status, actief
) VALUES (
  '00000000-0000-4000-8000-000000000448', 'RJC448 edge smoke fixture',
  'msp_broker', 'html', '*/15 * * * *', 60, 0, 'ready', 'toegestaan', true
);
INSERT INTO curated.scrape_run (id, bron_id) VALUES (
  '00000000-0000-4000-8000-000000004480',
  '00000000-0000-4000-8000-000000000448'
);
INSERT INTO curated.aanvraag (
  id, titel, beschrijving, bron_id, bron_referentie, content_hash,
  eerste_gezien_op, laatst_gezien_op, extractie_methode, raw_payload_ref,
  scrape_run_id, status
) VALUES (
  '00000000-0000-4000-8000-000000004481',
  'RJC448 Synthetic Edge Engineer', 'Disposable stateless edge smoke fixture',
  '00000000-0000-4000-8000-000000000448', 'rjc448-smoke',
  'rjc448-smoke-hash', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z',
  'html_parser', 'raw/smoke/rjc448.html',
  '00000000-0000-4000-8000-000000004480', 'active'
);
INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload)
VALUES (
  '00000000-0000-4000-8000-000000004481', 'aanvraag',
  'aanvraag.nieuw', '{}'::jsonb
);
SQL

projected="false"
for _attempt in {1..30}; do
  processed="$({
    "${compose_command[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 \
      -U ji_admin -d ji_smoke -tAc \
      "SELECT processed_at IS NOT NULL FROM curated.outbox_event WHERE aggregate_id = '00000000-0000-4000-8000-000000004481'"
  } | tr -d '[:space:]')"
  if [[ "$processed" == "t" ]]; then
    projected="true"
    break
  fi
  sleep 1
done
if [[ "$projected" != "true" ]]; then
  echo "MCP edge smoke: projector did not acknowledge fixture" >&2
  exit 1
fi

"${compose_command[@]}" exec -T \
  -e AUTH_BOOTSTRAP_ENABLED=1 \
  -e AUTH_BOOTSTRAP_CONFIRM=PROVISION_AUTH_USER \
  -e AUTH_BOOTSTRAP_EMAIL=edge-smoke-user@example.invalid \
  -e 'AUTH_BOOTSTRAP_NAME=MCP Edge Smoke User' \
  -e AUTH_BOOTSTRAP_PASSWORD=synthetic-edge-smoke-password \
  -e AUTH_BOOTSTRAP_ROLE=recruiter \
  server-a bun src/auth/provision-user.ts

"${compose_command[@]}" exec -T \
  -e MCP_EDGE_URL=http://edge:8080 \
  -e MCP_EDGE_SOURCE_SHA="$source_sha" \
  server-a bun /app/scripts/mcp-edge-smoke.ts >"$artifact_dir/evidence.json"

server_a_image_id="$("${compose_command[@]}" images -q server-a | head -n 1)"
server_b_image_id="$("${compose_command[@]}" images -q server-b | head -n 1)"
proxy_image_id="$("${compose_command[@]}" images -q edge | head -n 1)"
if [[ "$server_a_image_id" != "$server_b_image_id" ]]; then
  echo "MCP edge smoke: server instances use different image identities" >&2
  exit 1
fi
jq -n \
  --arg proxyImageId "$proxy_image_id" \
  --arg prHeadSha "$pr_head_sha" \
  --arg routeConfigSha "$runtime_route_config_sha" \
  --arg serverAImageId "$server_a_image_id" \
  --arg serverBImageId "$server_b_image_id" \
  --arg sourceSha "$source_sha" \
  '{proxyImageId: $proxyImageId, prHeadSha: $prHeadSha, routeConfigSha: $routeConfigSha, serverAImageId: $serverAImageId, serverBImageId: $serverBImageId, testedSha: $sourceSha}' \
  >"$artifact_dir/runtime-identity.json"

echo "MCP edge smoke: stateless round-robin protocol path passed"
