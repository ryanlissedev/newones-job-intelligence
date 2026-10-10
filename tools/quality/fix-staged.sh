#!/usr/bin/env bash
set -euo pipefail

# Lefthook helper: format every supported staged file and lint staged TS/JS.

PATH="./node_modules/.bin:$PATH"

format_files=()
lint_files=()
for file in "$@"; do
  case "$file" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs)
      format_files+=("$file")
      lint_files+=("$file")
      ;;
    *.json | *.yml | *.yaml) format_files+=("$file") ;;
  esac
done

if ((${#format_files[@]} > 0)); then
  oxfmt --write --no-error-on-unmatched-pattern "${format_files[@]}"
fi

if ((${#lint_files[@]} > 0)); then
  ultracite fix "${lint_files[@]}"
fi
