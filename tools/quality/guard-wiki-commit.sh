#!/usr/bin/env bash
set -euo pipefail

# Fail when openwiki/ is staged together with non-wiki source changes.

# Merge commits are atomic — their staged tree can't be split into a wiki-only
# commit, so the rule only applies to authored (non-merge) commits.
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  exit 0
fi

wiki_staged=0
other_staged=0
wiki_files=""
other_files=""

staged_files="$(git diff --cached --name-only --diff-filter=ACMRD)" || {
  echo "guard-wiki-commit: failed to inspect staged files" >&2
  exit 1
}

if [[ -n "$staged_files" ]]; then
  while IFS= read -r file; do
    case "$file" in
      openwiki/INSTRUCTIONS.md) continue ;;
      openwiki/*)
        wiki_staged=1
        wiki_files="${wiki_files} ${file}"
        ;;
      *)
        other_staged=1
        other_files="${other_files} ${file}"
        ;;
    esac
  done <<<"$staged_files"
fi

if [[ "$wiki_staged" -eq 1 && "$other_staged" -eq 1 ]]; then
  echo "guard-wiki-commit: refuse mixed commit — openwiki/ staged with other changes."
  echo "  Wiki files:${wiki_files}"
  echo "  Other files:${other_files}"
  echo "Commit OpenWiki updates separately (see openwiki/update branch / CI PR)."
  exit 1
fi
