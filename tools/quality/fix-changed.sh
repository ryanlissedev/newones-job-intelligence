#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PATH="./node_modules/.bin:$PATH"

files=()
resolved_files="$(bash tools/quality/resolve-changed.sh)"
if [[ -n "$resolved_files" ]]; then
  while IFS= read -r file; do
    files+=("$file")
  done <<<"$resolved_files"
fi

if ((${#files[@]} == 0)); then
  echo "fix: nothing to fix (no changed files vs origin/main outside docs/ and openwiki/)"
  exit 0
fi

lint_files=()
for file in "${files[@]}"; do
  case "$file" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs) lint_files+=("$file") ;;
  esac
done

echo "fix: oxfmt on ${#files[@]} changed file(s)"
oxfmt --write --no-error-on-unmatched-pattern "${files[@]}"

if ((${#lint_files[@]} == 0)); then
  echo "fix: ultracite skipped (no changed TS/JS files)"
else
  echo "fix: ultracite on ${#lint_files[@]} changed TS/JS file(s)"
  ultracite fix "${lint_files[@]}"
fi
