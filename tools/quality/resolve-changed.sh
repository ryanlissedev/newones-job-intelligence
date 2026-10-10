#!/usr/bin/env bash
set -euo pipefail

# Resolve the union of branch, index, worktree, and untracked changes.
# Never falls back to whole-tree. Excludes docs/ and openwiki/ by policy.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BASE="${QUALITY_BASE_REF:-origin/main}"

if ! git rev-parse --verify "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "resolve-changed: base ref '$BASE' is missing or is not a commit" >&2
  exit 1
fi

branch_files="$(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD)" || {
  echo "resolve-changed: failed to compare HEAD with '$BASE'" >&2
  exit 1
}
staged_files="$(git diff --cached --name-only --diff-filter=ACMR)" || {
  echo "resolve-changed: failed to inspect staged changes" >&2
  exit 1
}
worktree_files="$(git diff --name-only --diff-filter=ACMR)" || {
  echo "resolve-changed: failed to inspect unstaged changes" >&2
  exit 1
}
untracked_files="$(git ls-files --others --exclude-standard)" || {
  echo "resolve-changed: failed to inspect untracked files" >&2
  exit 1
}

filtered_untracked_files="$(
  printf '%s\n' "$untracked_files" | while IFS= read -r file; do
    if [[ -z "$file" ]]; then
      continue
    fi
    # libgit2 can leave an empty atomic-write scratchfile behind. Ignore only
    # that untracked zero-byte artifact class; tracked files and non-empty
    # lookalikes remain quality inputs.
    if [[ "$file" == _git2_* && ! -s "$file" ]]; then
      continue
    fi
    printf '%s\n' "$file"
  done
)"

printf '%s\n%s\n%s\n%s\n' \
  "$branch_files" \
  "$staged_files" \
  "$worktree_files" \
  "$filtered_untracked_files" \
  | sort -u \
  | while IFS= read -r file; do
  case "$file" in
    docs/* | openwiki/* | "") continue ;;
    *)
      if [[ -f "$file" ]]; then
        printf '%s\n' "$file"
      fi
      ;;
  esac
done
