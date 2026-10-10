#!/usr/bin/env bash
set -euo pipefail

if ! command -v qlty >/dev/null 2>&1; then
  echo "qlty CLI is required; install it from https://docs.qlty.sh/cli/installation" >&2
  exit 1
fi

bash tools/quality/run-qlty.sh check --no-upgrade-check --no-progress --no-formatters "$@"
