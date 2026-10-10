#!/usr/bin/env bash
# Off-provider export of the Neon production database (ADR-0006, RJC-381).
#
# A Neon-only backup is one account-loss event away from being the only copy
# of production data. This script pg_dumps Neon (custom format, the only
# format pg_restore round-trips and that supports selective/parallel restore)
# to local disk, so an operator can also push it to Hetzner Object Storage or
# any off-provider destination.
#
# Usage:
#   NEON_DATABASE_URL=... bash tools/postgres/neon-export.sh /path/to/out.dump
#   NEON_DATABASE_URL=... bash tools/postgres/neon-export.sh /path/to/out.dump --verify
#
# --verify additionally restores the dump into a throwaway *local* Postgres
# cluster (initdb + pg_ctl on a Unix socket only, no TCP listener, no
# docker — this repo's restore-drill.sh already owns the docker/wal-g lane)
# and compares row counts plus one table's checksum against Neon. The scratch
# cluster is destroyed unconditionally on exit.
#
# Never pass the connection string as a CLI argument (it would appear in
# `ps`/shell history) — export it as an environment variable. This script
# never echoes NEON_DATABASE_URL or DATABASE_URL; every diagnostic line is
# sizes/durations/counts only.
set -euo pipefail

out_path="${1:?usage: neon-export.sh <output-path> [--verify]}"
verify_mode="${2:-}"

neon_url="${NEON_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$neon_url" ]]; then
  echo "neon-export: set NEON_DATABASE_URL (or DATABASE_URL) — refusing to run without a source" >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "neon-export: required command '$1' is missing." >&2
    echo "neon-export: on macOS: brew install postgresql@17, then add its bin dir to PATH" >&2
    echo "neon-export: (e.g. export PATH=\"\$(brew --prefix postgresql@17)/bin:\$PATH\")" >&2
    exit 1
  fi
}

require_command pg_dump

# Second-precision timing, portable across GNU date (Linux) and BSD date
# (macOS) — `%3N` (milliseconds) is a GNU-only extension and misparses on
# BSD date, so this deliberately does not attempt millisecond precision.
now_s() { date +%s; }

mkdir -p "$(dirname "$out_path")"

echo "neon-export: dumping Neon to ${out_path} (custom format)"
started_at_s="$(now_s)"
pg_dump "$neon_url" --format=custom --no-owner --no-privileges --file="$out_path"
finished_at_s="$(now_s)"
duration_s="$((finished_at_s - started_at_s))"
size_bytes="$(stat -f%z "$out_path" 2>/dev/null || stat -c%s "$out_path")"

echo "neon-export: wrote ${size_bytes} bytes in ${duration_s}s"

if [[ "$verify_mode" != "--verify" ]]; then
  exit 0
fi

require_command pg_restore
require_command initdb
require_command pg_ctl
require_command psql
require_command createdb

echo "neon-export: --verify — restoring into a throwaway local Postgres cluster"

scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/neon-export-verify.XXXXXX")"
# Unix socket path has a ~103-byte limit on macOS/BSD; a fixed short dir under
# /tmp (not the mktemp dir, which may be long) keeps this portable regardless
# of how deep the caller's own tmp/workdir is.
sock_dir="$(mktemp -d /tmp/neon-verify-sock.XXXXXX)"
data_dir="${scratch_root}/data"
restore_port="${NEON_EXPORT_VERIFY_PORT:-55499}"

cleanup() {
  pg_ctl -D "$data_dir" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$scratch_root" "$sock_dir"
}
trap cleanup EXIT

initdb -D "$data_dir" -U scratch_owner -A trust --no-locale --encoding=UTF8 >"${scratch_root}/initdb.log" 2>&1
pg_ctl -D "$data_dir" -o "-p ${restore_port} -k ${sock_dir} -h ''" -l "${scratch_root}/server.log" start >/dev/null

for _ in $(seq 1 30); do
  if pg_isready -h "$sock_dir" -p "$restore_port" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

createdb -h "$sock_dir" -p "$restore_port" -U scratch_owner neon_verify

restore_started_s="$(now_s)"
# pg_restore against a fresh, non-Neon-schema-aware database: expect harmless
# warnings for roles/extensions it doesn't recognize (--no-owner already
# dropped ownership commands; this is a correctness drill on data + schema,
# not a full production-equivalent restore).
pg_restore -h "$sock_dir" -p "$restore_port" -U scratch_owner -d neon_verify \
  --no-owner --no-privileges "$out_path" 2>"${scratch_root}/restore.log" || true
restore_finished_s="$(now_s)"
restore_duration_s="$((restore_finished_s - restore_started_s))"

echo "neon-export: local restore took ${restore_duration_s}s (warnings, if any, in ${scratch_root}/restore.log)"

table_to_check="${NEON_EXPORT_VERIFY_TABLE:-curated.aanvraag}"

echo "neon-export: comparing row count for ${table_to_check}"
neon_count="$(psql "$neon_url" -Atqc "SELECT count(*) FROM ${table_to_check};")"
restored_count="$(psql -h "$sock_dir" -p "$restore_port" -U scratch_owner -d neon_verify -Atqc "SELECT count(*) FROM ${table_to_check};")"

echo "neon-export: ${table_to_check} row count — Neon=${neon_count} restored=${restored_count}"

if [[ "$neon_count" != "$restored_count" ]]; then
  echo "neon-export: VERIFY FAILED — row counts differ" >&2
  exit 1
fi

echo "neon-export: computing a table checksum (md5 of ordered row hashes) for ${table_to_check}"
# SET timezone=UTC first: timestamptz columns render differently under each
# session's default timezone, which would make the checksum diverge on
# identical data. Casting rows to jsonb (not ::text) avoids ROW(...)-syntax
# quoting differences between server versions (Neon is PG18, the scratch
# cluster may be an older major).
checksum_query="SET timezone = 'UTC'; SELECT md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.id::text)) FROM ${table_to_check} t;"
neon_checksum="$(psql "$neon_url" -Atqc "$checksum_query")"
restored_checksum="$(psql -h "$sock_dir" -p "$restore_port" -U scratch_owner -d neon_verify -Atqc "$checksum_query")"

echo "neon-export: ${table_to_check} checksum — Neon=${neon_checksum} restored=${restored_checksum}"

if [[ "$neon_checksum" != "$restored_checksum" ]]; then
  echo "neon-export: VERIFY FAILED — checksums differ" >&2
  exit 1
fi

echo "neon-export: VERIFY PASSED — row count and checksum match for ${table_to_check}"
