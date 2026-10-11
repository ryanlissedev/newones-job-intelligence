#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="$repo_root/apps/web/.next-e2e-fixtures"
stamp_file="$build_dir/.build-stamp"

cd "$repo_root"

# HEAD plus the content of uncommitted web/package changes, so an edited
# working tree rebuilds instead of serving a stale fixture build.
expected_stamp="$(
  {
    git rev-parse HEAD
    git diff HEAD -- apps/web packages
    git ls-files --others --exclude-standard -- apps/web packages | xargs -r sha256sum
  } | sha256sum | cut -d' ' -f1
)"

if [[ "${E2E_FIXTURES_REBUILD:-0}" != "1" && -f "$stamp_file" && "$(<"$stamp_file")" == "$expected_stamp" ]]; then
  exit 0
fi

rm -rf "$build_dir"
mkdir -p "$build_dir"

# `next build` with a custom distDir rewrites apps/web/tsconfig.json (adds the
# dist types globs) and next-env.d.ts; restore both so a fixture run never
# leaves the working tree dirty.
backup_dir="$(mktemp -d)"
cp apps/web/tsconfig.json "$backup_dir/tsconfig.json"
if [[ -f apps/web/next-env.d.ts ]]; then
  cp apps/web/next-env.d.ts "$backup_dir/next-env.d.ts"
fi
restore_web_config() {
  cp "$backup_dir/tsconfig.json" apps/web/tsconfig.json
  if [[ -f "$backup_dir/next-env.d.ts" ]]; then
    cp "$backup_dir/next-env.d.ts" apps/web/next-env.d.ts
  fi
  rm -rf "$backup_dir"
}
trap restore_web_config EXIT

auth_port="${E2E_FIXTURES_AUTH_PORT:-3310}"
(
  cd apps/web
  NEXT_PUBLIC_USE_FIXTURES=1 \
  NEXT_PUBLIC_SERVER_URL="http://127.0.0.1:${auth_port}" \
  NEXT_TELEMETRY_DISABLED=1 \
  JI_WEB_DIST_DIR=.next-e2e-fixtures \
  PATH="./node_modules/.bin:$PATH" \
  next build --webpack
)

printf '%s' "$expected_stamp" >"$stamp_file"
