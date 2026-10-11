#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

visual_mode="${E2E_VISUAL:-report}"
case "$visual_mode" in
  off|report|enforce|update) ;;
  *)
    echo "E2E_VISUAL must be one of: off, report, enforce, update" >&2
    exit 2
    ;;
esac

if [[ -z "${E2E_LIVE_WEB_URL:-}" ]]; then
  echo "E2E_LIVE_WEB_URL is required" >&2
  exit 2
fi

e2e_status=0
E2E_TELEMETRY_DISABLED=1 E2E_VISUAL="$visual_mode" \
  PATH="./node_modules/.bin:$PATH" e2e run --config e2e.live.config.ts || e2e_status=$?

compare_status=0
if [[ "$visual_mode" != "off" ]]; then
  PATH="./node_modules/.bin:$PATH" bun scripts/e2e/visual-compare.ts \
    --suite live \
    --mode "$visual_mode" || compare_status=$?
fi

if (( e2e_status != 0 )); then
  exit "$e2e_status"
fi
if [[ "$visual_mode" == "enforce" ]]; then
  exit "$compare_status"
fi
exit 0
