#!/usr/bin/env bash
# Load unset POSTGRES_* keys from the Compose env file into the current shell.
#
# Why: Claude Code's Stop hook and lefthook pre-push run `bun run gate` in a
# process that does not inherit a developer's interactive shell exports. Docker
# Compose already read `.env` (or `.env.example`) when Postgres started, so the
# gate's test-isolation / migration-upgrade helpers must see the same
# POSTGRES_* credentials — otherwise they fall back to hardcoded defaults and
# fail closed with auth errors (28P01) against a running instance.
#
# Rules:
# - Prefer `.env` when present, else `.env.example`.
# - Never override a variable already set in the environment (CI injects its
#   own; an operator override always wins).
# - Only touch `POSTGRES_*` keys (no auth secrets, no DATABASE_URL dumps).
# - Never print values.
#
# Usage: `source` from another bash script. Safe to call multiple times.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "load-compose-env.sh: source this file; do not execute it" >&2
  exit 1
fi

_ji_compose_env_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_ji_compose_env_file="${GATE_COMPOSE_ENV_FILE:-}"

if [[ -z "$_ji_compose_env_file" ]]; then
  if [[ -f "$_ji_compose_env_root/.env" ]]; then
    _ji_compose_env_file="$_ji_compose_env_root/.env"
  elif [[ -f "$_ji_compose_env_root/.env.example" ]]; then
    _ji_compose_env_file="$_ji_compose_env_root/.env.example"
  else
    unset _ji_compose_env_root _ji_compose_env_file
    return 0
  fi
fi

if [[ ! -f "$_ji_compose_env_file" ]]; then
  echo "load-compose-env.sh: Compose env file '$_ji_compose_env_file' not found" >&2
  unset _ji_compose_env_root _ji_compose_env_file
  return 1
fi

_ji_loaded=0
while IFS= read -r _ji_line || [[ -n "$_ji_line" ]]; do
  # Strip CR from CRLF checkouts without touching the value otherwise.
  _ji_line="${_ji_line%$'\r'}"

  case "$_ji_line" in
    "" | \#*)
      continue
      ;;
  esac

  case "$_ji_line" in
    POSTGRES_[A-Z0-9_]*=*)
      ;;
    *)
      continue
      ;;
  esac

  _ji_key="${_ji_line%%=*}"
  _ji_value="${_ji_line#"${_ji_key}"=}"

  # Drop optional surrounding single or double quotes (Compose-style).
  if [[ "$_ji_value" == \"*\" && "$_ji_value" == *\" ]]; then
    _ji_value="${_ji_value:1:${#_ji_value}-2}"
  elif [[ "$_ji_value" == \'*\' && "$_ji_value" == *\' ]]; then
    _ji_value="${_ji_value:1:${#_ji_value}-2}"
  fi

  # Skip when the key is already set (including to empty string).
  if [[ -n "${!_ji_key+x}" ]]; then
    continue
  fi

  export "${_ji_key}=${_ji_value}"
  _ji_loaded=$((_ji_loaded + 1))
done <"$_ji_compose_env_file"

if [[ "${GATE_COMPOSE_ENV_VERBOSE:-}" == "1" ]]; then
  echo "load-compose-env.sh: loaded ${_ji_loaded} unset POSTGRES_* key(s) from ${_ji_compose_env_file}"
fi

# Derive the host-side database URLs the Stop hook / gate need for `@ji/env`
# and Drizzle when a developer has not exported them (Claude Stop, bare
# `bun run gate`). Compose uses these same role/password/db values.
#
# Userinfo must be percent-encoded: a password containing `@`, `:`, `/`, `?`,
# `#`, or `%` would otherwise split the URL and hand `@ji/env` / postgres.js
# the wrong host (or a parse error) even though Compose itself started fine.
_ji_urlencode() {
  # RFC 3986 unreserved set stays literal; everything else → %XX.
  local _ji_raw=$1
  local _ji_out=""
  local _ji_i _ji_c _ji_ord
  local _ji_len=${#_ji_raw}
  for ((_ji_i = 0; _ji_i < _ji_len; _ji_i++)); do
    _ji_c=${_ji_raw:_ji_i:1}
    case "$_ji_c" in
      [A-Za-z0-9.~_-])
        _ji_out+="$_ji_c"
        ;;
      *)
        printf -v _ji_ord "%d" "'$_ji_c"
        _ji_out+=$(printf "%%%02X" "$_ji_ord")
        ;;
    esac
  done
  printf "%s" "$_ji_out"
}

_ji_pg_host_port="${POSTGRES_HOST_PORT:-5432}"
_ji_pg_db="${POSTGRES_DB:-ji_test}"
_ji_pg_app_user="$(_ji_urlencode "${POSTGRES_APP_USER:-ji_app}")"
_ji_pg_app_password="$(_ji_urlencode "${POSTGRES_APP_PASSWORD:-ji_app_local}")"
_ji_pg_migrator_user="$(_ji_urlencode "${POSTGRES_MIGRATOR_USER:-ji_migrator}")"
_ji_pg_migrator_password="$(_ji_urlencode "${POSTGRES_MIGRATOR_PASSWORD:-ji_migrator_local}")"

if [[ -z "${DATABASE_URL+x}" ]]; then
  export DATABASE_URL="postgresql://${_ji_pg_app_user}:${_ji_pg_app_password}@127.0.0.1:${_ji_pg_host_port}/${_ji_pg_db}"
fi
if [[ -z "${MIGRATION_DATABASE_URL+x}" ]]; then
  export MIGRATION_DATABASE_URL="postgresql://${_ji_pg_migrator_user}:${_ji_pg_migrator_password}@127.0.0.1:${_ji_pg_host_port}/${_ji_pg_db}"
fi
if [[ -z "${PROJECTOR_DATABASE_URL+x}" ]]; then
  export PROJECTOR_DATABASE_URL="postgresql://${_ji_pg_app_user}:${_ji_pg_app_password}@127.0.0.1:${_ji_pg_host_port}/${_ji_pg_db}"
fi

unset -f _ji_urlencode
unset _ji_compose_env_root _ji_compose_env_file _ji_line _ji_key _ji_value _ji_loaded
unset _ji_pg_host_port _ji_pg_db
unset _ji_pg_app_user _ji_pg_app_password _ji_pg_migrator_user _ji_pg_migrator_password
