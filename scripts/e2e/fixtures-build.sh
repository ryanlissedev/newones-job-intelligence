#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="$repo_root/.e2e-fixtures/web"
stamp_file="$build_dir/.build-stamp"
auth_port="${E2E_FIXTURES_AUTH_PORT:-3310}"

cd "$repo_root"

# HEAD, the uncommitted web/package/root-manifest diff (the root package.json
# owns the workspace catalog, bun.lock pins transitive deps), untracked-file
# hashes, and the auth port make an edited working tree, a dependency change
# or changed runtime configuration rebuild.
expected_stamp="$(
  {
    git rev-parse HEAD
    git diff HEAD -- apps/web packages package.json bun.lock
    git ls-files --others --exclude-standard -- apps/web packages | xargs -r sha256sum
    printf '%s\n' "$auth_port"
  } | sha256sum | cut -d' ' -f1
)"

if [[ "${E2E_FIXTURES_REBUILD:-0}" != "1" && -f "$stamp_file" && "$(<"$stamp_file")" == "$expected_stamp" ]]; then
  exit 0
fi

if [[ -e "$build_dir" ]]; then
  rm -r -- "$build_dir"
fi
mkdir -p "$build_dir"

# Build a copy so Next can freely update generated files without touching the
# tracked web app. The copy remains at depth two so ../../packages resolves.
while IFS= read -r -d '' source_file; do
  relative_path="${source_file#apps/web/}"
  target_file="$build_dir/$relative_path"
  mkdir -p "$(dirname "$target_file")"
  cp -p -- "$source_file" "$target_file"
done < <(git ls-files -co --exclude-standard -z -- apps/web)
ln -s ../../apps/web/node_modules "$build_dir/node_modules"

(
  cd "$build_dir"
  NEXT_PUBLIC_USE_FIXTURES=1 \
  NEXT_PUBLIC_SERVER_URL="http://127.0.0.1:${auth_port}" \
  NEXT_TELEMETRY_DISABLED=1 \
  PATH="./node_modules/.bin:$PATH" \
  next build --webpack
)

printf '%s' "$expected_stamp" >"$stamp_file"
