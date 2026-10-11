#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bash scripts/e2e/fixtures-build.sh
fixture_password="$(openssl rand -hex 24)"
export E2E_USER_FIXTURE_PASSWORD="$fixture_password"
export E2E_TELEMETRY_DISABLED=1
# @e2e-dev/web 0.11.2 has no timezoneId option; Chromium inherits TZ, and the
# committed baselines render fixture timestamps in Europe/Amsterdam.
export TZ=Europe/Amsterdam
visual_mode="${E2E_VISUAL_MODE:-${E2E_VISUAL:-enforce}}"
export E2E_VISUAL="$visual_mode"

e2e_status=0
PATH="./node_modules/.bin:$PATH" e2e run --config e2e.fixtures.config.ts "$@" || e2e_status=$?

compare_status=0
if [[ "$visual_mode" != "off" ]]; then
  PATH="./node_modules/.bin:$PATH" bun scripts/e2e/visual-compare.ts \
    --suite fixtures \
    --mode "$visual_mode" || compare_status=$?
fi

if (( e2e_status != 0 )); then
  exit "$e2e_status"
fi
exit "$compare_status"
