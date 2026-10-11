#!/usr/bin/env bash
# Log every production action; hard-block destructive ones.
# See AGENTS.md "Production release lane" and docs/runbooks/automatic-production-deploy.md.
# Approval: Ryan's RELEASE_APPROVAL=PR-<n> or dated release-approval file. Decisions log to
# $PRODUCTION_GATE_LOG or $XDG_STATE_HOME/newones/production-gate.log.
# Limitation: this hook lives in the repository, so an agent with Write access could edit it;
# such changes are visible in the PR diff. Obfuscated commands (variables, string splicing,
# base64) can evade text matching, and tunnelled local psql to prod (ssh -L plus psql localhost)
# is indistinguishable from local dev psql. A GitHub Environment required reviewer is optional
# CI protection, not this hook's hard gate.
# Codex's workspace-write sandbox cannot write the approval file outside the repo; Codex
# PreToolUse is registered for Bash only.
# Operator-local production-gate.conf accepts `host <name-or-ip>` and `db-container <name>`;
# it lives under the user config directory and must never be committed.
set -euo pipefail

RAW_INPUT=$(cat || true)
TOOL_NAME=""
COMMAND_TEXT=""
TARGET_PATH=""
PARSE_ERROR=""
APPROVAL_ID="-"
APPROVAL_SOURCE="-"
APPROVAL_REASON="no valid human approval was found"
PARSE_FAILED=false
PRODUCTION_EXTRA_HOSTS=()
PRODUCTION_EXTRA_DB_CONTAINERS=()

strip_match_quotes() {
  local value=$1
  value=${value//\'/}
  value=${value//\"/}
  printf '%s' "$value"
}

lower_text() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

resolved_approval_file() {
  printf '%s' "${RELEASE_APPROVAL_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/newones/release-approval}"
}

resolved_production_gate_config() {
  printf '%s' "${PRODUCTION_GATE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/newones/production-gate.conf}"
}

production_gate_config_path_matches() {
  local target=$1
  local config_file
  config_file=$(resolved_production_gate_config)
  case $target in
    ~/*) target=$HOME/${target#~/} ;;
  esac
  [[ $target == "$config_file" ]]
}

production_gate_config_reference_in() {
  local value=$1
  local match
  match=$(strip_match_quotes "$value")
  [[ $match == *production-gate.conf* || $match == *PRODUCTION_GATE_CONFIG* || $match == *production_gate_config* ]] && return 0
  local config_file
  config_file=$(resolved_production_gate_config)
  [[ $match == *"$config_file"* ]]
}

has_tamper_write() {
  local lower_command=$1
  local in_place_re='(^|[[:space:]])(sed|perl)[[:space:]][^[:space:]]*-[^[:space:]]*i[^[:space:]]*([[:space:]]|$)'
  local awk_in_place_re='(^|[[:space:]])awk[[:space:]]+[^[:space:]]*-[[:space:]]*i[[:space:]]+inplace([[:space:]]|$)'
  local editor_re='(^|[[:space:]])(ed|ex)[[:space:]]+|(^|[[:space:]])vim[[:space:]]+.*(^|[[:space:]])-c([[:space:]=]|$)'
  local python_open_re='(^|[[:space:]])python(3)?[[:space:]]+[^[:space:]]*-c[^[:space:]]+open\('
  [[ $lower_command =~ (^|[[:space:]"])(cp|mv|install|ln|touch|truncate|dd|tee|echo|printf)([[:space:]]|") ]] && return 0
  [[ $lower_command == *">"* ]] && return 0
  [[ $lower_command == *"export release_approval"* || $lower_command == *"release_approval="* ]] && return 0
  [[ $lower_command == *"export production_gate_config"* || $lower_command == *"production_gate_config="* ]] && return 0
  [[ $lower_command =~ $in_place_re ]] && return 0
  [[ $lower_command =~ $awk_in_place_re ]] && return 0
  [[ $lower_command =~ $editor_re ]] && return 0
  [[ $lower_command =~ $python_open_re ]] && return 0
  return 1
}

load_production_gate_config() {
  local config_file
  local directive
  local value
  config_file=$(resolved_production_gate_config)
  [[ -r $config_file ]] || return 0
  while IFS=' ' read -r directive value; do
    case $directive in
      host)
        [[ -n $value ]] && PRODUCTION_EXTRA_HOSTS+=("$value")
        ;;
      db-container)
        [[ -n $value ]] && PRODUCTION_EXTRA_DB_CONTAINERS+=("$value")
        ;;
    esac
  done < "$config_file"
}

approval_path_matches() {
  local target=$1
  local approval_file
  approval_file=$(resolved_approval_file)
  case $target in
    ~/*) target=$HOME/${target#~/} ;;
  esac
  [[ $target == "$approval_file" ]]
}

approval_reference_in() {
  local value=$1
  local match
  match=$(strip_match_quotes "$value")
  [[ $match == *RELEASE_APPROVAL* || $match == *release-approval* ]] && return 0
  local approval_file
  approval_file=$(resolved_approval_file)
  [[ $match == *"$approval_file"* ]]
}

decode_base64() {
  local value=$1
  local decoded
  if decoded=$(printf '%s' "$value" | base64 --decode 2>/dev/null); then
    printf '%s' "$decoded"
    return 0
  fi
  printf '%s' "$value" | base64 -D 2>/dev/null
}

parse_with_jq() {
  local tool_b64 command_b64 target_b64
  tool_b64=$(printf '%s' "$RAW_INPUT" | jq -er '(.tool_name // "") | @base64') || return 1
  command_b64=$(printf '%s' "$RAW_INPUT" | jq -er '
    if (.tool_input.command? | type) == "array" then
      (.tool_input.command | map(tostring) | join(" "))
    elif (.tool_input.command? | type) == "string" then
      .tool_input.command
    elif (.tool_input.cmd? | type) == "array" then
      (.tool_input.cmd | map(tostring) | join(" "))
    elif (.tool_input.cmd? | type) == "string" then
      .tool_input.cmd
    else "" end | @base64
  ') || return 1
  target_b64=$(printf '%s' "$RAW_INPUT" | jq -er '(.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // "") | tostring | @base64') || return 1
  TOOL_NAME=$(decode_base64 "$tool_b64") || return 1
  COMMAND_TEXT=$(decode_base64 "$command_b64") || return 1
  TARGET_PATH=$(decode_base64 "$target_b64") || return 1
}

parse_with_runtime() {
  local runtime=$1
  local parsed tool_b64 command_b64 target_b64
  if [[ $runtime == bun ]]; then
    parsed=$(printf '%s' "$RAW_INPUT" | bun -e '
      const input = await new Response(Bun.stdin.stream()).text();
      const value = JSON.parse(input);
      const tool = value.tool_name ?? "";
      const toolInput = value.tool_input ?? {};
      const candidate = toolInput.command ?? toolInput.cmd;
      const command = Array.isArray(candidate) ? candidate.map(String).join(" ") : (typeof candidate === "string" ? candidate : "");
      const target = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? "";
      console.log(Buffer.from(String(tool)).toString("base64"));
      console.log(Buffer.from(command).toString("base64"));
      console.log(Buffer.from(String(target)).toString("base64"));
    ') || return 1
  else
    parsed=$(printf '%s' "$RAW_INPUT" | python3 -c '
import base64
import json
import sys

value = json.load(sys.stdin)
tool = value.get("tool_name", "")
tool_input = value.get("tool_input") or {}
candidate = tool_input.get("command")
if candidate is None:
    candidate = tool_input.get("cmd")
if isinstance(candidate, list):
    candidate = " ".join(str(item) for item in candidate)
if not isinstance(candidate, str):
    candidate = ""
target = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path") or ""
print(base64.b64encode(str(tool).encode()).decode())
print(base64.b64encode(candidate.encode()).decode())
print(base64.b64encode(str(target).encode()).decode())
') || return 1
  fi
  tool_b64=$(printf '%s\n' "$parsed" | sed -n '1p')
  command_b64=$(printf '%s\n' "$parsed" | sed -n '2p')
  target_b64=$(printf '%s\n' "$parsed" | sed -n '3p')
  [[ -n $tool_b64 ]] || return 1
  TOOL_NAME=$(decode_base64 "$tool_b64") || return 1
  COMMAND_TEXT=$(decode_base64 "$command_b64") || return 1
  TARGET_PATH=$(decode_base64 "$target_b64") || return 1
}

parse_input() {
  if command -v jq >/dev/null 2>&1 && parse_with_jq; then
    return 0
  fi
  if command -v bun >/dev/null 2>&1 && parse_with_runtime bun; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1 && parse_with_runtime python3; then
    return 0
  fi
  PARSE_ERROR="could not parse PreToolUse JSON with jq, bun, or python3"
  return 1
}

raw_mentions_production() {
  local raw_lower
  raw_lower=$(lower_text "$RAW_INPUT")
  [[ $raw_lower =~ rollback\.sh|release_apps\.sh|migrate-only\.sh|coolify-deploy\.ts ]] && return 0
  [[ $raw_lower =~ deploy-production|deploy[[:space:]]+production|/api/v1/|catapulze-hetzner ]] && return 0
  [[ $raw_lower =~ gh[[:space:]]+workflow|docker[[:space:]]|psql|postgres://|postgresql://|production ]] && return 0
  return 1
}

raw_mentions_tamper() {
  local raw_lower
  raw_lower=$(lower_text "$RAW_INPUT")
  if [[ $raw_lower == *release_approval* || $raw_lower == *release-approval* ]]; then
    has_tamper_write "$raw_lower" && return 0
  fi
  if [[ $raw_lower == *production-gate.conf* || $raw_lower == *production_gate_config* ]]; then
    has_tamper_write "$raw_lower" && return 0
  fi
  return 1
}

raw_mentions_destructive() {
  local raw_lower
  raw_lower=$(lower_text "$RAW_INPUT")
  raw_mentions_tamper && return 0
  [[ $raw_lower =~ delete[[:space:]]+from|truncate|drop[[:space:]]+(table|schema|database|materialized[[:space:]]+view|view|owned|extension|index)|alter[[:space:]]+table[^\;]*drop[[:space:]]+(column|constraint) ]] && return 0
  [[ $raw_lower =~ docker[^\n]*(volume[[:space:]]+(rm|prune)|system[[:space:]]+prune[^\n]*--volumes|compose[^\n]+down[^\n]*(-v|--volumes)) ]] && return 0
  [[ $raw_lower =~ docker[^\n]*(rm|container[[:space:]]+rm)[^\n]*(-f|--force)[^\n]*(postgres|postgis|pg|db|database|manticore) ]] && return 0
  [[ $raw_lower =~ (^|[[:space:]])rm[[:space:]]+(-[^[:space:]]*[rR]|--recursive) ]] && return 0
  [[ $raw_lower =~ git[[:space:]]+push[^\n]*(--force|-f|--mirror|--delete|:[[:space:]]*(main|master)|\+[^[:space:]]*(main|master)) ]] && return 0
  [[ $raw_lower =~ gh[[:space:]]+repo[[:space:]]+delete|gh[^\n]*api[^\n]*(delete|--method[=[:space:]]*delete) ]] && return 0
  [[ $raw_lower =~ (curl|wget|http|https|xh)[^\n]*(delete|--request)[^\n]*/api/v1/ ]] && return 0
  [[ $raw_lower =~ pg_resetwal|pg_rewind|initdb|pg_ctl[^\n]*(stop[^\n]*immediate|promote)|/var/lib/postgresql|pgdata|pg_wal|postgres-data|/data/coolify/databases ]] && return 0
  return 1
}

# shellcheck disable=SC2329 # invoked via trap ERR below
fail_safe() {
  if raw_mentions_destructive || raw_mentions_tamper; then
    local parse_reason=${PARSE_ERROR:-the hook could not parse the request}
    printf '%s\n' \
      'BLOCKED by production-gate' \
      'Category: input-parse-error' \
      "Reason: ${parse_reason}; its raw input mentions a destructive action or approval tampering." \
      "This is destructive and irreversible and needs Ryan's explicit approval. Ryan must start the session with RELEASE_APPROVAL=PR-<n> or write PR-<n> <today> to the approval file himself; the agent must never set or forge either approval." \
      'Deploys, rollbacks and restarts are NOT blocked; they are only logged.' >&2
    exit 2
  fi
  exit 0
}

trap fail_safe ERR
# set -u aborts (and other unexpected exits) bypass the ERR trap; route any exit other
# than 0/2 through the same fail-safe so a crash never silently allows a destructive command.
# shellcheck disable=SC2329 # invoked via trap EXIT below
on_unexpected_exit() {
  local status=$?
  if [[ $status -ne 0 && $status -ne 2 ]]; then
    fail_safe
  fi
}
trap on_unexpected_exit EXIT

if ! parse_input; then
  if raw_mentions_destructive || raw_mentions_tamper; then
    PARSE_FAILED=true
  elif raw_mentions_production; then
    COMMAND_TEXT=$RAW_INPUT
    TOOL_NAME=Bash
    PARSE_FAILED=true
  else
    exit 0
  fi
fi

log_decision() {
  local decision=$1
  local category=$2
  local approval=$3
  local approval_detail=$approval
  local command_for_log=$COMMAND_TEXT
  local log_path=${PRODUCTION_GATE_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/newones/production-gate.log}
  local log_dir=${log_path%/*}
  local timestamp
  [[ $log_dir == "$log_path" ]] && log_dir=.
  # Perl is available on macOS and Linux; BSD sed has no /I flag.
  # Without Perl, omit the command rather than append it unredacted.
  if command -v perl >/dev/null 2>&1; then
    command_for_log=$(printf '%s' "$command_for_log" |
      perl -pe '
        s/(Authorization:\s*[A-Za-z][A-Za-z0-9_-]*\s+)[^\s"\x27]+/${1}REDACTED/gi;
        s/((?:X-API-Key|X-Auth-Token|Cookie):\s*)[^\s"\x27]+/${1}REDACTED/gi;
        s/((?:X-[A-Za-z0-9_-]*Token):\s*)[^\s"\x27]+/${1}REDACTED/gi;
        s/(Bearer\s+)[^\s"\x27]+/${1}REDACTED/gi;
        s#([A-Za-z][A-Za-z0-9+.-]*://[^/@\s]+:)[^/@\s]+@#${1}REDACTED@#g;
        s/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS)=)(?:"[^"]*"|\x27[^\x27]*\x27|[^\s]+)/${1}REDACTED/gi;
        s/(token=)[^\s&"\x27]+/${1}REDACTED/gi;
        s/((?:--(?:token|password)(?:=|\s+)))(?:"[^"]*"|\x27[^\x27]*\x27|[^\s&]+)/${1}REDACTED/gi;
        s/((?:--(?:token|password|bearer-token|api-key|secret)(?:=|\s+)))(?:"[^"]*"|\x27[^\x27]*\x27|[^\s&]+)/${1}REDACTED/gi;
        s/((?:"(?:token|password|secret|apikey)"\s*:\s*)")([^"\\]*(?:\\.[^"\\]*)*)"/${1}REDACTED"/gi;
      ' | tr '\n' ' ' || true)
  else
    command_for_log='[command omitted: perl unavailable for redaction]'
  fi
  if [[ $approval != "-" ]]; then
    approval_detail="$approval ($APPROVAL_SOURCE)"
  fi
  command_for_log=${command_for_log:0:200}
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown-time')
  mkdir -p "$log_dir" 2>/dev/null || true
  printf '%s\t%s\t%s\t%s\t%s\n' "$timestamp" "$decision" "$category" "$approval_detail" "$command_for_log" >> "$log_path" 2>/dev/null || true
}

# Record the first log-only category but keep scanning: a later segment may still be
# destructive (e.g. `curl …/deploy; curl -X DELETE …`). The LOGGED line is written at the end.
PENDING_LOG_CATEGORY=""
log_action() {
  [[ -n $PENDING_LOG_CATEGORY ]] || PENDING_LOG_CATEGORY=$1
  return 0
}

approval_from_file() {
  local approval_file
  local first_line=""
  local today=${PRODUCTION_GATE_TODAY:-$(date +%F)}
  local line
  approval_file=$(resolved_approval_file)
  [[ -r $approval_file ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*$ || $line =~ ^[[:space:]]*# ]] && continue
    first_line=$line
    break
  done < "$approval_file"
  if [[ -z $first_line ]]; then
    APPROVAL_REASON="the approval file is empty or contains only comments"
    return 1
  fi
  if [[ ! $first_line =~ ^(PR-[1-9][0-9]*)[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})[[:space:]]*$ ]]; then
    APPROVAL_REASON="the approval file is malformed; Ryan must write PR-<n> <today>"
    return 1
  fi
  if [[ ${BASH_REMATCH[2]} != "$today" ]]; then
    APPROVAL_REASON="the approval file is expired; it says ${BASH_REMATCH[2]}, but today is $today"
    return 1
  fi
  APPROVAL_ID=${BASH_REMATCH[1]}
  APPROVAL_SOURCE='file'
  return 0
}

has_human_approval() {
  local env_approval=${RELEASE_APPROVAL:-}
  if [[ $env_approval =~ ^PR-[1-9][0-9]*$ ]]; then
    APPROVAL_ID=$env_approval
    APPROVAL_SOURCE='env'
    return 0
  fi
  if [[ -n $env_approval ]]; then
    APPROVAL_REASON="RELEASE_APPROVAL is malformed; only Ryan may set PR-<n>"
  fi
  approval_from_file && return 0
  return 1
}

emit_block() {
  local category=$1
  local reason=$2
  log_decision BLOCKED "$category" "-"
  printf '%s\n' \
    'BLOCKED by production-gate' \
    "Category: ${category}" \
    "Reason: ${reason} This is destructive and irreversible and needs Ryan's explicit approval." \
    'Ryan must start the session with RELEASE_APPROVAL=PR-<n> or write PR-<n> <today> to the approval file himself; the agent must never set or forge either approval.' \
    'Deploys, rollbacks and restarts are NOT blocked; they are only logged.' >&2
  exit 2
}

block_or_allow() {
  local category=$1
  local reason=$2
  if has_human_approval; then
    printf 'production-gate: ALLOWED by %s (%s)\n' "$APPROVAL_ID" "$APPROVAL_SOURCE" >&2
    log_decision ALLOWED "$category" "$APPROVAL_ID"
    exit 0
  fi
  if [[ $APPROVAL_REASON != "no valid human approval was found" ]]; then
    reason="$reason ${APPROVAL_REASON}."
  fi
  emit_block "$category" "$reason"
}

is_readonly_reference() {
  local segment=$1
  local normalized
  local -a words=()
  local index=0
  local word
  normalized=$(strip_match_quotes "$segment")
  read -r -a words <<< "$normalized"
  while (( index < ${#words[@]} )); do
    case ${words[index]} in
      *=*|sudo|env|command|time|nohup) index=$((index + 1)) ;;
      *) break ;;
    esac
  done
  case ${words[index]:-} in
    cat|less|more|rg|grep|egrep|head|tail|bat|wc|file|stat|ls) return 0 ;;
    sed)
      for word in "${words[@]:index + 1}"; do
        [[ $word == -i || $word == --in-place || $word == -i* ]] && return 1
      done
      return 0
      ;;
    git)
      case ${words[index + 1]:-} in
        diff|show|log|blame|grep) return 0 ;;
      esac
      ;;
  esac
  return 1
}

is_script_description() {
  local segment=$1
  local -a words=()
  local index=0
  local normalized
  normalized=$(strip_match_quotes "$segment")
  read -r -a words <<< "$normalized"
  while (( index < ${#words[@]} )); do
    case ${words[index]} in
      *=*|sudo|env|command|time|nohup) index=$((index + 1)) ;;
      *) break ;;
    esac
  done
  case ${words[index]:-} in
    git)
      case ${words[index + 1]:-} in
        commit|add|status|restore|stash) return 0 ;;
      esac
      ;;
    gh)
      case ${words[index + 1]:-}:${words[index + 2]:-} in
        pr:create|pr:edit|pr:comment|pr:view|pr:diff|issue:view|issue:comment) return 0 ;;
      esac
      ;;
  esac
  return 1
}

split_segments() {
  local text=$COMMAND_TEXT
  local newline=$'\n'
  text=${text//&&/$newline}
  text=${text//||/$newline}
  text=${text//;/$newline}
  text=${text//|/$newline}
  printf '%s\n' "$text"
}

is_description_only_segment() {
  local segment=$1
  local normalized
  local lower_segment
  local backtick='`'
  local -a words=()
  normalized=$(strip_match_quotes "$segment")
  lower_segment=$(lower_text "$segment")
  [[ $segment =~ \$\( || $segment == *"$backtick"* ]] && return 1
  [[ $segment == *";"* || $segment == *"&&"* || $segment == *"||"* ]] && return 1
  read -r -a words <<< "$normalized"
  case ${words[0]:-}:${words[1]:-}:${words[2]:-} in
    git:commit:*|git:tag:*) return 0 ;;
    gh:pr:create|gh:pr:edit|gh:pr:comment) return 0 ;;
    gh:issue:*) return 0 ;;
   echo:*|printf:*)
      local lower_command
      lower_command=$(lower_text "$COMMAND_TEXT")
      [[ ! $lower_command =~ \|[[:space:]]*(bash|sh|zsh|dash|bun|node|xargs|eval)([[:space:]]|$) && $lower_segment != *">"* ]] && return 0
     ;;
  esac
  return 1
}

check_script_actions() {
  local lower_command
  local segment
  local category
  local backtick='`'
  lower_command=$(lower_text "$(strip_match_quotes "$COMMAND_TEXT")")
  [[ $lower_command =~ rollback\.sh|release_apps\.sh|migrate-only\.sh|coolify-deploy\.ts ]] || return 1
  category=production-script
  [[ $lower_command == *coolify-deploy.ts* ]] && category=production-driver
  if [[ $lower_command == *"$backtick"* || $lower_command =~ \$\( || $lower_command =~ \|[[:space:]]*(bash|sh|zsh|dash|bun|node|xargs|eval)([[:space:]]|$) || $lower_command =~ (^|[\;|&[:space:]])(source|\.)[[:space:]] || $lower_command =~ (^|[\;|&[:space:]])(eval|xargs)[[:space:]] ]]; then
    log_action "$category"
  fi
  while IFS= read -r segment || [[ -n $segment ]]; do
    [[ -n ${segment//[[:space:]]/} ]] || continue
    if [[ $segment =~ rollback\.sh|release_apps\.sh|migrate-only\.sh|coolify-deploy\.ts ]] && ! is_readonly_reference "$segment" && ! is_script_description "$segment"; then
      log_action "$category"
    fi
  done < <(split_segments)
  return 1
}

production_host_matches_token() {
  local token=$1
  local host
  local candidate
  token=$(strip_match_quotes "$token")
  token=${token#DOCKER_HOST=}
  token=${token#docker_host=}
  token=${token#PGHOST=}
  token=${token#pghost=}
  token=${token#HostName=}
  token=${token#hostname=}
  token=${token#*://}
  token=${token#*@}
  token=${token%%[/?#]*}
  token=${token%%:*}
  candidate=$(lower_text "$token")
  for host in catapulze-hetzner catapulze-prod ${PRODUCTION_EXTRA_HOSTS[@]+"${PRODUCTION_EXTRA_HOSTS[@]}"}; do
    [[ $candidate == "$(lower_text "$host")" ]] && return 0
  done
  return 1
}

is_hetzner_target_command() {
  local command=$1
  local normalized
  local -a words=()
  local index=0
  local word
  normalized=$(strip_match_quotes "$command")
  read -r -a words <<< "$normalized"
  while (( index < ${#words[@]} )); do
    word=${words[index]}
   if [[ $word == DOCKER_HOST=* || $word == docker_host=* ]]; then
     production_host_matches_token "$word" && return 0
   fi
    if [[ $word == PGHOST=* || $word == pghost=* || $word == postgres://* || $word == postgresql://* ]]; then
      production_host_matches_token "$word" && return 0
    fi
   case $word in
     ssh|scp|rsync)
        for ((index = index + 1; index < ${#words[@]}; index++)); do
          production_host_matches_token "${words[index]}" && return 0
        done
       return 1
       ;;
      psql)
        for ((index = index + 1; index < ${#words[@]}; index++)); do
          case ${words[index]} in
            -h|--host)
              index=$((index + 1))
              production_host_matches_token "${words[index]:-}" && return 0
              ;;
            -h*|--host=*)
              production_host_matches_token "${words[index]#*=}" && return 0
              ;;
            postgres://*|postgresql://*)
              production_host_matches_token "${words[index]}" && return 0
              ;;
          esac
        done
        return 1
        ;;
     docker)
        for ((index = index + 1; index < ${#words[@]}; index++)); do
          case ${words[index]} in
            -H|--host)
              index=$((index + 1))
              production_host_matches_token "${words[index]:-}" && return 0
              ;;
           -H*|--host=*)
             production_host_matches_token "${words[index]#*=}" && return 0
             ;;
            --context)
              index=$((index + 1))
              production_host_matches_token "${words[index]:-}" && return 0
              ;;
            --context=*)
              production_host_matches_token "${words[index]#*=}" && return 0
              ;;
         esac
        done
        return 1
        ;;
    esac
    index=$((index + 1))
  done
  return 1
}

is_local_host() {
  local host=$1
  host=${host%%[/?#]*}
  case $host in
    ""|localhost|localhost:*|127.0.0.1|127.0.0.1:*|::1|\[::1\]|/\*) return 0 ;;
    postgres|postgres:*|db|db:*) return 0 ;;
  esac
  return 1
}

connection_host_is_local() {
 local lower_command=$1
 local host
  if [[ $lower_command =~ (^|[[:space:]])pghost=([^[:space:]]+) ]]; then
    host=${BASH_REMATCH[2]}
    is_local_host "$host"
    return
  fi
 if [[ $lower_command =~ postgres(ql)?://[^@/[:space:]]+@([^/:?[:space:]]+) ]]; then
    host=${BASH_REMATCH[2]}
    is_local_host "$host"
    return
  fi
  if [[ $lower_command =~ (^|[[:space:]])(-h|--host)(=|[[:space:]]+)([^[:space:]]+) ]]; then
    host=${BASH_REMATCH[4]}
    host=$(strip_match_quotes "$host")
    is_local_host "$host"
    return
  fi
  if [[ $lower_command =~ (^|[[:space:]])(-h|--host)([^[:space:]]+) ]]; then
    host=${BASH_REMATCH[3]#=}
    is_local_host "$host"
    return
  fi
  return 0
}

has_sql_connection_marker() {
  local lower_command=$1
  [[ $lower_command =~ (^|[^[:alnum:]_])psql([[:space:]]|$) || $lower_command == *database_url=* || $lower_command =~ postgres(ql)?:// ]]
}

sql_is_destructive() {
  local sql=$1
  local lower_sql
  local statement
  lower_sql=$(lower_text "$sql")
  lower_sql=${lower_sql//;/$'\n'}
  while IFS= read -r statement || [[ -n $statement ]]; do
    [[ -n ${statement//[[:space:]]/} ]] || continue
    [[ $statement =~ (^|[^[:alnum:]_])delete([[:space:]]|$) ]] && return 0
    [[ $statement =~ (^|[^[:alnum:]_])truncate([[:space:]]|$) ]] && return 0
    [[ $statement =~ (^|[^[:alnum:]_])drop[[:space:]]+(table|schema|database|materialized[[:space:]]+view|view|owned|extension)([[:space:]]|$) ]] && return 0
    if [[ $statement =~ (^|[^[:alnum:]_])drop[[:space:]]+index([[:space:]]|$) ]] && [[ ! $statement =~ drop[[:space:]]+index[[:space:]]+concurrently([[:space:]]|$) ]]; then
      return 0
    fi
    if [[ $statement =~ (^|[^[:alnum:]_])update([[:space:]]|$) ]] && [[ ! $statement =~ (^|[^[:alnum:]_])where([[:space:]]|$) ]]; then
      return 0
    fi
    if [[ $statement =~ (^|[^[:alnum:]_])alter[[:space:]]+table[^\;]*(drop[[:space:]]+(column|constraint)) ]]; then
      return 0
    fi
  done <<< "$lower_sql"
  return 1
}

is_readonly_psql() {
  local command=$1
  local lower_command
  local sql
  local command_marker
  lower_command=$(lower_text "$(strip_match_quotes "$command")")
  [[ $lower_command =~ (^|[^[:alnum:]_])psql([[:space:]]|$) ]] || return 1
  [[ ! $lower_command =~ (^|[[:space:]])(-f|--file)(=|[[:space:]]) ]] || return 1
  if [[ $lower_command == *"--command"* ]]; then
    command_marker=--command
  elif [[ $lower_command =~ (^|[[:space:]])-c([[:space:]=]) ]]; then
    command_marker=-c
  else
    return 1
  fi
  sql=${lower_command#*"$command_marker"}
  sql=${sql#=}
  while [[ -n $sql && ${sql:0:1} == [[:space:]] ]]; do sql=${sql:1}; done
  [[ $sql == select* || $sql == with* || $sql == show* || $sql == explain* || $sql == table* || $sql == values* || $sql == \\d* || $sql == \\l* || $sql == \\conninfo* || $sql == \\x* || $sql == \\timing* || $sql == \\pset* || $sql == \\echo* || $sql == \\q* ]] || return 1
  [[ $sql != *" select "*into* && $sql != select*into* ]] || return 1
  [[ $sql != *pg_terminate_backend* && $sql != *pg_cancel_backend* && $sql != *nextval* && $sql != *setval* && $sql != *"set role"* ]] || return 1
  [[ $sql != *"\\!"* && $sql != *"\\gexec"* && $sql != *"\\copy"* && $sql != *"\\i "* && $sql != *"\\ir "* && $sql != *"\\o "* && $sql != *"\\w "* && $sql != *"\\g "* && $sql != *"\\setenv"* && $sql != *"\\password"* && $sql != *"\\c "* && $sql != *"\\connect "* && $sql != *"\\lo_export"* ]] || return 1
  return 0
}

check_sql_action() {
 local command=$1
 local lower_command
 local production_sql=false
  is_description_only_segment "$command" && return 1
  lower_command=$(lower_text "$command")
  has_sql_connection_marker "$lower_command" || return 1
  if is_hetzner_target_command "$command" || ! connection_host_is_local "$lower_command"; then
    production_sql=true
  fi
  $production_sql || return 1
  if sql_is_destructive "$command"; then
    block_or_allow sql-destructive "The visible SQL contains a destructive statement targeting a production database."
  fi
  if is_readonly_psql "$command"; then
    return 1
  fi
  log_action sql-write
}

has_rm_recursive() {
 local command=$1
 local normalized
 local -a words=()
 local index
  local word
  normalized=$(lower_text "$(strip_match_quotes "$command")")
 read -r -a words <<< "$normalized"
  if [[ $normalized =~ (^|[[:space:]\(])([^[:space:]]*/)?rm[[:space:]]+(-[^[:space:]]*r|--recursive) ]]; then
    return 0
  fi
 for ((index = 0; index < ${#words[@]}; index++)); do
    [[ ${words[index]} == rm || ${words[index]} == */rm ]] || continue
   index=$((index + 1))
    while (( index < ${#words[@]} )); do
      word=${words[index]}
      [[ $word == --recursive || ( $word == -[[:alnum:]]* && $word == *r* ) ]] && return 0
      [[ $word == -- || $word != -* ]] && break
      index=$((index + 1))
    done
 done
  if [[ $normalized =~ (^|[[:space:]])find([[:space:]]|$) ]] && [[ $normalized == *" -delete"* || $normalized =~ [[:space:]]-exec[[:space:]]+([^[:space:]]*/)?rm([[:space:]]|$) ]]; then
    return 0
  fi
 return 1
}

has_docker_volume_destroy() {
  local lower_command=$1
  [[ $lower_command =~ docker.*[[:space:]]volume[[:space:]]+(rm|prune)([[:space:]]|$) ]] && return 0
  if [[ $lower_command =~ docker.*[[:space:]]system[[:space:]]+prune([[:space:]]|$) ]] && [[ $lower_command == *--volumes* ]]; then
    return 0
  fi
  if [[ $lower_command =~ docker.*[[:space:]](compose|docker-compose)[[:space:]].*[[:space:]]down([[:space:]]|$) ]] && [[ $lower_command == *" -v"* || $lower_command == *" --volumes"* ]]; then
    return 0
  fi
  return 1
}

has_db_container_destroy() {
  local command=$1
  local normalized
  local -a words=()
  local index=0
  local word
  local subcommand
  local force=false
  local target
  local db_container
  normalized=$(strip_match_quotes "$command")
  read -r -a words <<< "$normalized"
  while (( index < ${#words[@]} )); do
    [[ ${words[index]} == docker ]] || { index=$((index + 1)); continue; }
    index=$((index + 1))
    while (( index < ${#words[@]} )) && [[ ${words[index]} == -* ]]; do
      case ${words[index]} in
        -H|--host|--context|-l|--log-level|--config) index=$((index + 2)) ;;
        -H*|--host=*|--context=*|--config=*) index=$((index + 1)) ;;
        *) index=$((index + 1)) ;;
      esac
    done
    subcommand=${words[index]:-}
    if [[ $subcommand == container ]]; then
      index=$((index + 1))
      subcommand=${words[index]:-}
    fi
    [[ $subcommand == rm ]] || continue
    index=$((index + 1))
    force=false
 while (( index < ${#words[@]} )); do
 word=${words[index]}
  case $word in
        -f|--force|-*f*) force=true ;;
        --) index=$((index + 1)); break ;;
        -*) ;;
        *) break ;;
      esac
      index=$((index + 1))
    done
    $force || continue
    while (( index < ${#words[@]} )); do
      target=${words[index]}
      if [[ $target =~ (^|[^[:alnum:]])(postgresql|postgres|postgis|pg|db|database|manticore)([^[:alnum:]]|$) ]]; then
        return 0
      fi
      for db_container in ${PRODUCTION_EXTRA_DB_CONTAINERS[@]+"${PRODUCTION_EXTRA_DB_CONTAINERS[@]}"}; do
        [[ $target == "$db_container" ]] && return 0
      done
      index=$((index + 1))
    done
  done
  return 1
}

has_pg_data_change() {
 local command=$1
 local lower_command
  local write_re='(^|[^[:alnum:]_-])(rm|mv|cp|chown|chmod|scp|rsync|tee|truncate|dd|ln|mkdir|touch|install)([[:space:]]|$)'
  lower_command=$(lower_text "$command")
  [[ $lower_command =~ pg_resetwal|pg_rewind|initdb|pg_ctl.*(stop.*-m[[:space:]]+immediate|promote) ]] && return 0
  [[ $lower_command =~ /var/lib/postgresql|pgdata|pg_wal|postgres-data|/data/coolify/databases ]] || return 1
  if [[ $lower_command =~ $write_re || $lower_command =~ (^|[^[:alnum:]_-])sed[[:space:]]+[^[:space:]]*-[^[:space:]]*i[^[:space:]] || $lower_command == *'>'* ]]; then
    return 0
  fi
  return 1
}

has_force_push_main() {
 local command=$1
 local lower_command
 local normalized
 local -a words=()
 local index=0
 local word
 local force=false
 local mirror=false
 local delete=false
 local saw_remote=false
 local saw_ref=false
 local protected_ref=false
 local current_branch=${PRODUCTION_GATE_CURRENT_BRANCH:-}
 lower_command=$(lower_text "$command")
 is_description_only_segment "$command" && return 1
 [[ $lower_command =~ (^|[[:space:]])git[[:space:]].*push([[:space:]]|$) ]] || return 1
 normalized=$(strip_match_quotes "$command")
 read -r -a words <<< "$normalized"
 for ((index = 0; index < ${#words[@]}; index++)); do
   [[ ${words[index]} == push ]] && break
 done
 index=$((index + 1))
 while (( index < ${#words[@]} )); do
   word=${words[index]}
    word=${word%\)}
   case $word in
      --force|-f|--force-with-lease|--force-with-lease=*|--force-if-includes) force=true ;;
      --mirror) force=true; mirror=true ;;
      --delete) force=true; delete=true ;;
      --repo|--receive-pack|--exec|--push-option|--signed|--set-upstream|-o) index=$((index + 1)) ;;
      --repo=*|--receive-pack=*|--exec=*|--push-option=*|--signed=*|-o=*) ;;
      -*) ;;
      *)
        if [[ $saw_remote == false ]]; then
          saw_remote=true
        else
          saw_ref=true
          if [[ $word == +main || $word == +master || $word == +HEAD:main || $word == +HEAD:master || $word == +refs/heads/main || $word == +refs/heads/master || $word == refs/heads/main || $word == refs/heads/master || $word == main || $word == master || $word == :main || $word == :master || $word == HEAD:main || $word == HEAD:master || $word == *:main || $word == *:master || $word == *:refs/heads/main || $word == *:refs/heads/master || ( $delete == true && ( $word == main || $word == master ) ) ]]; then
            protected_ref=true
          fi
        fi
        ;;
    esac
    index=$((index + 1))
  done
  if [[ $mirror == true ]]; then return 0; fi
  $force || return 1
  if [[ $protected_ref == true ]]; then return 0; fi
  $saw_ref && return 1
  if [[ -z $current_branch ]]; then
    current_branch=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  fi
  [[ $current_branch == main || $current_branch == master ]]
}

check_hetzner_write() {
 local command=$1
 local match_command
 local lower_command
 local sql_nested_ok=false
  is_description_only_segment "$command" && return 1
  local service_write_re='(^|[^[:alnum:]_-])service[[:space:]]+[^[:space:]]+[[:space:]]+(update|restart|stop|start|reload)([[:space:]]|$)'
  local systemctl_write_re='(^|[^[:alnum:]_-])systemctl[[:space:]]+(restart|stop|start|reload)([[:space:]]|$)'
  local simple_write_re='(^|[^[:alnum:]_-])(rm|mv|kill|chmod|chown|cp|ln|truncate|dd|reboot|shutdown|mkdir|rmdir|touch|install|useradd|usermod|passwd|ufw|iptables|nft|certbot)([[:space:]]|$)'
  local package_write_re='(^|[^[:alnum:]_-])(apt|apt-get|yum|dnf)[[:space:]]+(install|remove|upgrade)([[:space:]]|$)'
  local sed_write_re='(^|[^[:alnum:]_-])sed[[:space:]]+[^[:space:]]*-[^[:space:]]*i[^[:space:]]*([[:space:]]|$)'
  local redirection_re='(^|[^2])[>][^&]'
  match_command=$(strip_match_quotes "$command")
  lower_command=$(lower_text "$match_command")
  has_docker_volume_destroy "$lower_command" && block_or_allow docker-volume-destroy "The command would destroy Docker volumes on the production Hetzner host."
  has_db_container_destroy "$match_command" && block_or_allow db-container-destroy "The command would force-remove a production database container."
  has_rm_recursive "$match_command" && block_or_allow server-rm-rf "The command would recursively remove files on the production Hetzner host."
  has_pg_data_change "$match_command" && block_or_allow pg-data-change "The command would change PostgreSQL data or control state on the production Hetzner host."
  if [[ $lower_command =~ (^|[^[:alnum:]_-])(scp|rsync)([[:space:]]|$) ]]; then log_action hetzner-write; fi
  if is_readonly_psql "$command"; then sql_nested_ok=true; fi
  if [[ $lower_command =~ docker.*[[:space:]]exec([[:space:]]|$) ]] && [[ $sql_nested_ok == false ]]; then log_action hetzner-write; fi
  if [[ $lower_command =~ $redirection_re ]]; then log_action hetzner-write; fi
  if [[ $lower_command =~ $service_write_re || $lower_command =~ $systemctl_write_re || $lower_command =~ $simple_write_re || $lower_command =~ $package_write_re || $lower_command =~ $sed_write_re || $lower_command =~ docker.*[[:space:]](run|restart|rm|stop|start|kill|update|cp)([[:space:]]|$) || $lower_command =~ docker.*[[:space:]](compose|docker-compose).*(up|down|restart|rm|stop|start|pull|run|exec|kill|create|scale)([[:space:]]|$) || $lower_command =~ docker.*[[:space:]](volume|network|system|image|builder)[[:space:]]+(rm|prune|create)([[:space:]]|$) ]]; then log_action hetzner-write; fi
  return 1
}

case $TOOL_NAME in
  Write|Edit|MultiEdit|NotebookEdit)
    if approval_path_matches "$TARGET_PATH" || approval_reference_in "$TARGET_PATH" || production_gate_config_path_matches "$TARGET_PATH" || production_gate_config_reference_in "$TARGET_PATH"; then
      emit_block approval-tamper "The tool would write or edit the approval file or production-gate.conf; approval tampering cannot be overridden."
    fi
    exit 0
    ;;
esac

if [[ -n $TOOL_NAME && ! $TOOL_NAME =~ ^(Bash|bash|shell|exec_command|command|terminal|run[-_]command)$ ]]; then exit 0; fi

if $PARSE_FAILED; then
  if raw_mentions_destructive || raw_mentions_tamper; then
    emit_block input-parse-error "${PARSE_ERROR:-The hook could not parse a request whose raw input mentions a destructive action or approval tampering.}"
  fi
  log_decision LOGGED input-parse-error -
  exit 0
fi

load_production_gate_config

if [[ -z $COMMAND_TEXT ]]; then exit 0; fi

if ! is_description_only_segment "$COMMAND_TEXT" && { approval_reference_in "$COMMAND_TEXT" || production_gate_config_reference_in "$COMMAND_TEXT"; }; then
  tamper_match=$(strip_match_quotes "$COMMAND_TEXT")
  tamper_lower=$(lower_text "$tamper_match")
  if has_tamper_write "$tamper_lower"; then
    emit_block approval-tamper "The command would write or edit the approval file or production-gate.conf; approval tampering cannot be overridden."
  fi
fi

backtick='`'
if [[ $COMMAND_TEXT =~ \$\( || $COMMAND_TEXT == *"$backtick"* ]] && has_rm_recursive "$COMMAND_TEXT"; then
  block_or_allow server-rm-rf "The command would recursively remove files from a command substitution."
fi
check_sql_action "$COMMAND_TEXT" || true
if is_hetzner_target_command "$COMMAND_TEXT"; then check_hetzner_write "$COMMAND_TEXT" || true; fi
if has_force_push_main "$COMMAND_TEXT"; then block_or_allow force-push-main "The command would force-update or delete the protected main or master branch."; fi


check_script_actions || true
while IFS= read -r segment || [[ -n $segment ]]; do
 [[ -n ${segment//[[:space:]]/} ]] || continue
  is_description_only_segment "$segment" && continue
 match_segment=$(strip_match_quotes "$segment")
 lower_segment=$(lower_text "$match_segment")
  if [[ $lower_segment =~ (curl|wget|http|https|xh).*(/api/v1/) ]] && [[ $lower_segment =~ (^|[[:space:]])(-x[[:space:]=]*delete|--request[=[:space:]]*delete|--method[=[:space:]]*delete|((http|https|xh)[[:space:]]+delete))([[:space:]]|$) ]]; then
    block_or_allow coolify-delete "The command would send an HTTP DELETE request to a Coolify API path."
  fi
  if [[ $lower_segment =~ /api/v1/deploy([^[:alnum:]_]|$) ]]; then log_action coolify-api-deploy; fi
  if [[ $lower_segment =~ /api/v1/(applications|services|databases)/[^[:space:]/?]+/(restart|start|stop)([^[:alnum:]_]|$) ]]; then log_action coolify-api-lifecycle; fi
  if [[ $lower_segment =~ (^|[^[:alnum:]_-])(curl|wget|http|https|xh)([[:space:]]|$) && $lower_segment == */api/v1/* ]] && [[ $lower_segment =~ (^|[[:space:]])(-x|--request|--method|--data|--data-raw|--data-binary|--data-urlencode|--json|-f|--form|--upload-file|-t|--post-data|--post-file)(=|[[:space:]]) || $lower_segment =~ (^|[[:space:]])-x(post|put|patch|delete)([[:space:]]|$) || $lower_segment =~ (^|[[:space:]])(http|https|xh)[[:space:]]+(post|put|patch)([[:space:]]|$) ]]; then log_action coolify-api-write; fi
  if [[ $lower_segment =~ gh[[:space:]]+workflow[[:space:]]+run ]] && [[ $lower_segment == *deploy-production* || $lower_segment == *"deploy production"* ]]; then log_action github-production-dispatch; fi
  if [[ $lower_segment =~ gh[[:space:]]+api[[:space:]] ]] && [[ $lower_segment == */actions/workflows/deploy-production.yml/dispatches* ]]; then log_action github-production-dispatch; fi
 if [[ $lower_segment =~ gh[[:space:]]+run[[:space:]]+rerun ]] && [[ $lower_segment == *deploy-production* || $lower_segment == *"deploy production"* ]]; then log_action github-production-dispatch; fi
  if [[ $lower_segment =~ (^|[[:space:]])gh[[:space:]]+repo[[:space:]]+delete([[:space:]]|$) ]]; then block_or_allow gh-repo-delete "The command would delete a GitHub repository."; fi
  if [[ $lower_segment =~ gh[[:space:]]+api ]] && [[ $lower_segment =~ -x[[:space:]=]*delete|--method[=[:space:]]*delete ]] && [[ $lower_segment =~ repos/[^/[:space:]]+/[^/[:space:]?]+([[:space:]]|$) ]]; then block_or_allow gh-repo-delete "The command would delete a GitHub repository through the API."; fi
done < <(split_segments)

if [[ -n $PENDING_LOG_CATEGORY ]]; then
  log_decision LOGGED "$PENDING_LOG_CATEGORY" "-"
fi
exit 0
