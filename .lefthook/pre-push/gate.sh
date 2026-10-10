#!/usr/bin/env bash
# Runs as a lefthook script job so a push that only deletes files still runs
# the gate: command jobs are skipped when the push file list is empty, and
# lefthook builds that list without deletions (CTP-503).
set -euo pipefail
PATH="./node_modules/.bin:$PATH" bun run gate
