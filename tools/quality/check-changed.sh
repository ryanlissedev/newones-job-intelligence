#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PATH="./node_modules/.bin:$PATH"

if [[ -z "${QLTY_JOBS:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    QLTY_JOBS=1
  else
    QLTY_JOBS=2
  fi
fi

files=()
resolved_files="$(bash tools/quality/resolve-changed.sh)"
if [[ -n "$resolved_files" ]]; then
  while IFS= read -r file; do
    files+=("$file")
  done <<<"$resolved_files"
fi

lint_files=()
if ((${#files[@]} > 0)); then
  for file in "${files[@]}"; do
    case "$file" in
      *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$file") ;;
    esac
  done
fi

if ((${#files[@]} == 0)); then
  echo "check: nothing to check (no changed files vs origin/main outside docs/ and openwiki/)"
else
  echo "check: oxfmt on ${#files[@]} changed file(s)"
  oxfmt --check --no-error-on-unmatched-pattern "${files[@]}"
fi

if ((${#lint_files[@]} == 0)); then
  echo "check: ultracite skipped (no changed TS/JS files)"
else
  echo "check: ultracite on ${#lint_files[@]} changed TS/JS file(s)"
  ultracite check "${lint_files[@]}"
fi

if ((${#files[@]} == 0)); then
  echo "check: qlty skipped (no changed files)"
elif ! command -v qlty >/dev/null 2>&1; then
  echo "check: qlty CLI is required; install it from https://docs.qlty.sh/cli/installation" >&2
  exit 1
else
  echo "check: qlty on ${#files[@]} changed file(s) with $QLTY_JOBS job(s)"
  bash tools/quality/run-qlty.sh check --jobs "$QLTY_JOBS" --no-upgrade-check --no-progress --no-formatters "${files[@]}"
fi
