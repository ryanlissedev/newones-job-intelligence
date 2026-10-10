#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

scratch_files_before=("__qlty_sentinel__")
for file in _git2_*; do
  [[ -e "$file" ]] || continue
  scratch_files_before+=("$file")
done

cleanup_new_scratch_files() {
  local existed_before

  for file in _git2_*; do
    [[ -f "$file" && ! -s "$file" ]] || continue
    if git ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
      continue
    fi

    existed_before=0
    for previous_file in "${scratch_files_before[@]}"; do
      if [[ "$file" == "$previous_file" ]]; then
        existed_before=1
        break
      fi
    done
    if ((existed_before == 0)); then
      rm -- "$file"
    fi
  done
}

if qlty "$@"; then
  qlty_exit_code=0
else
  qlty_exit_code=$?
fi
cleanup_new_scratch_files
exit "$qlty_exit_code"
