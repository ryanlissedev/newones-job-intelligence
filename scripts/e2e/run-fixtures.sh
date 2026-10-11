#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

visual_mode="${E2E_VISUAL_MODE:-${E2E_VISUAL:-enforce}}"
case "$visual_mode" in
  off|report|enforce|update) ;;
  *)
    echo "E2E_VISUAL/E2E_VISUAL_MODE must be one of: off, report, enforce, update" >&2
    exit 2
    ;;
esac

bash scripts/e2e/fixtures-build.sh
fixture_password="$(openssl rand -hex 24)"
export E2E_USER_FIXTURE_PASSWORD="$fixture_password"
export E2E_TELEMETRY_DISABLED=1
# @e2e-dev/web 0.11.2 has no timezoneId option; Chromium inherits TZ, and the
# committed baselines render fixture timestamps in Europe/Amsterdam.
export TZ=Europe/Amsterdam
export E2E_VISUAL="$visual_mode"

# The runner leaves the previous report in place when it fails before writing
# a new one (e.g. APP_UNREACHABLE); never compare (or update baselines from) a
# stale report.
rm -f .e2e/report.json

e2e_status=0
PATH="./node_modules/.bin:$PATH" e2e run --config e2e.fixtures.config.ts "$@" || e2e_status=$?

compare_status=0
if [[ ! -f .e2e/report.json ]]; then
  echo "visual compare skipped: the e2e run produced no report" >&2
  (( e2e_status != 0 )) || e2e_status=1
elif [[ "$visual_mode" == "update" && "$e2e_status" != 0 ]]; then
  echo "visual compare skipped: refusing to update baselines from a failed e2e run" >&2
elif [[ "$visual_mode" != "off" ]]; then
  compare_args=(
    scripts/e2e/visual-compare.ts
    --suite fixtures
    --mode "$visual_mode"
  )
  # Only test selection makes a run partial (spec paths/positional selectors or
  # a tag/grep/last-failed filter); mode flags such as --headed must not hide
  # missing captures. A bare word right after a non-selector option is taken
  # as that option's value (fail-safe: at worst a full compare).
  partial_run=0
  previous=""
  end_of_options=0
  for argument in "$@"; do
    if (( end_of_options == 1 )); then
      partial_run=1
      continue
    fi
    case "$argument" in
      --) end_of_options=1 ;;
      *.e2e.ts|tests/*) partial_run=1 ;;
      --tag|--tag=*|--exclude-tag|--exclude-tag=*|--grep|--grep=*|--grep-invert|--grep-invert=*|-g|-t|--filter|--filter=*|--only|--only=*|--last-failed) partial_run=1 ;;
      -*) ;;
      *)
        case "$previous" in
          -*) [[ "$previous" == *=* ]] && partial_run=1 ;;
          *) partial_run=1 ;;
        esac
        ;;
    esac
    previous="$argument"
  done
  if (( partial_run == 1 )); then
    compare_args+=(--captured-only)
  fi
  PATH="./node_modules/.bin:$PATH" bun "${compare_args[@]}" || compare_status=$?
fi

if (( e2e_status != 0 )); then
  exit "$e2e_status"
fi
exit "$compare_status"
