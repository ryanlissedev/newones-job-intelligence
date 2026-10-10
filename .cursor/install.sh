#!/usr/bin/env bash
# Idempotent bootstrap for the Catapulze Job Intelligence dev environment.
# The declared stack is Bun + TypeScript; Node, Go and Rust ship with the base
# image, so this script only needs to add Bun and make it reachable on PATH.
set -euo pipefail

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

if [ ! -x "$BUN_INSTALL/bin/bun" ]; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
fi

# Expose bun on the system PATH so every fresh, non-login shell can find it,
# independent of shell-rc sourcing. Falls back silently without sudo.
if [ ! -e /usr/local/bin/bun ] && command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun || true
fi

echo "bun $(bun --version) ready"

# When application code lands (root package.json / bun.lockb), install its deps.
if [ -f package.json ]; then
  echo "Found package.json — installing dependencies..."
  if [ -f bun.lockb ] || [ -f bun.lock ]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
fi
