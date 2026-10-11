#!/usr/bin/env bash
# Guardrail for accidental or agent-initiated production actions.
# See AGENTS.md "Production release lane" and docs/runbooks/automatic-production-deploy.md.
# Approval: Ryan's RELEASE_APPROVAL=PR-<n> or release-approval file; CI uses the GitHub
# production Environment required reviewer. Decisions log to $PRODUCTION_GATE_LOG or
# $XDG_STATE_HOME/newones/production-gate.log.
# Limitation: this hook lives in the repository, so an agent with Write access could edit
# it; such changes are visible in the PR diff. For a non-negotiable gate, Ryan can copy
# it into managed settings or ~/.claude/settings.json. Obfuscated commands (variables,
# string splicing, base64) can evade text matching, and tunnelled local psql to prod
# (ssh -L plus psql localhost) is indistinguishable from local dev psql. The GitHub
# Environment reviewer is CI's hard gate.
# Codex's workspace-write sandbox cannot write the approval file outside the repo; Codex PreToolUse is registered for Bash only.
set -euo pipefail

RAW_INPUT=$(cat || true)
TOOL_NAME=""
COMMAND_TEXT=""
TARGET_PATH=""
PARSE_ERROR=""
APPROVAL_ID="-"
APPROVAL_SOURCE="-"
APPROVAL_REASON="no valid human approval was found"
PARSE_BLOCK=false

strip_match_quotes() {
  local value=$1
  value=${value//\'/}
  value=${value//\"/}
  printf '%s' "$value"
}

resolved_approval_file() {
  printf '%s' "${RELEASE_APPROVAL_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/newones/release-approval}"
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
  raw_lower=$(printf '%s' "$RAW_INPUT" | tr '[:upper:]' '[:lower:]')
  [[ $raw_lower =~ rollback\.sh|release_apps\.sh|migrate-only\.sh|coolify-deploy\.ts ]] && return 0
  [[ $raw_lower =~ deploy-production|deploy[[:space:]]+production|/api/v1/deploy ]] && return 0
  [[ $raw_lower =~ release_approval|release-approval|catapulze-hetzner ]] && return 0
  return 1
}

# shellcheck disable=SC2329 # invoked via trap ERR below
fail_safe() {
  if raw_mentions_production; then
    printf 'BLOCKED by production-gate\nCategory: internal-error\nReason: an unexpected hook error occurred while the request mentioned a production operation; the gate fails closed.\n' >&2
    exit 2
  fi
  exit 0
}

trap fail_safe ERR

if ! parse_input; then
  if raw_mentions_production; then
    PARSE_BLOCK=true
  else
    exit 0
  fi
fi

log_decision() {
  local decision=$1
  local category=$2
  local approval=$3
  local command_for_log=$COMMAND_TEXT
  local log_path=${PRODUCTION_GATE_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/newones/production-gate.log}
  local log_dir=${log_path%/*}
  local timestamp
  [[ $log_dir == "$log_path" ]] && log_dir=.
  # perl (present on macOS and Linux) gives case-insensitive redaction; BSD sed has no /I flag.
  # Without perl the command text is omitted rather than logged unredacted.
  if command -v perl >/dev/null 2>&1; then
    command_for_log=$(printf '%s' "$command_for_log" |
      perl -pe '
        s/(Authorization:\s*[A-Za-z][A-Za-z0-9_-]*\s+)[^\s"\x27]+/${1}REDACTED/gi;
        s/((?:X-API-Key|X-Auth-Token|Cookie):\s*)[^\s"\x27]+/${1}REDACTED/gi;
        s/(Bearer\s+)[^\s"\x27]+/${1}REDACTED/gi;
        s#([A-Za-z][A-Za-z0-9+.-]*://[^/@\s]+:)[^/@\s]+@#${1}REDACTED@#g;
        s/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS)=)(?:"[^"]*"|\x27[^\x27]*\x27|[^\s]+)/${1}REDACTED/gi;
        s/(token=)[^\s&"\x27]+/${1}REDACTED/gi;
        s/((?:--(?:token|password)(?:=|\s+)))(?:"[^"]*"|\x27[^\x27]*\x27|[^\s&]+)/${1}REDACTED/gi;
      ' | tr '\n' ' ' || true)
  else
    command_for_log='[command omitted: perl unavailable for redaction]'
  fi
  command_for_log=${command_for_log:0:200}
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown-time')
  mkdir -p "$log_dir" 2>/dev/null || true
  printf '%s\t%s\t%s\t%s\t%s\n' "$timestamp" "$decision" "$category" "$approval" "$command_for_log" >> "$log_path" 2>/dev/null || true
}

is_readonly_reference() {
  local segment=$1
  segment=$(strip_match_quotes "$segment")
  local -a words=()
  local index=0
  local word
  local command
  local subcommand

  read -r -a words <<< "$segment"
  while (( index < ${#words[@]} )); do
    word=${words[index]}
    if [[ $word =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      index=$((index + 1))
      continue
    fi
    case $word in
      sudo|env|command|time|nohup)
        index=$((index + 1))
        continue
        ;;
    esac
    break
  done

  command=${words[index]:-}
  case $command in
    cat|less|more|rg|grep|egrep|head|tail|bat|wc|file|stat|ls)
      return 0
      ;;
    sed)
      for word in "${words[@]:index + 1}"; do
        [[ $word == "-i" || $word == "--in-place" || $word == -i* ]] && return 1
      done
      return 0
      ;;
    git)
      subcommand=${words[index + 1]:-}
      [[ $subcommand == diff || $subcommand == show || $subcommand == log || $subcommand == blame || $subcommand == grep ]]
      return
      ;;
    bun)
      [[ ${words[index + 1]:-} == test ]]
      return
      ;;
  esac
  return 1
}

is_production_script_reference() {
  local segment=$1
  # shellcheck disable=SC2016 # literal "$(" to detect command substitution
  local command_substitution='$('
  local backtick='`'
  [[ $segment == *"$command_substitution"* || $segment == *"$backtick"* ]] && return 1
  segment=$(strip_match_quotes "$segment")
  local -a words=()
  local index=0
  local word
  local command
  local subcommand

  read -r -a words <<< "$segment"
  while (( index < ${#words[@]} )); do
    word=${words[index]}
    if [[ $word =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      index=$((index + 1))
      continue
    fi
    case $word in
      sudo|env|command|time|nohup)
        index=$((index + 1))
        continue
        ;;
    esac
    break
  done

  command=${words[index]:-}
  case $command in
    git)
      subcommand=${words[index + 1]:-}
      [[ $subcommand == commit || $subcommand == add || $subcommand == status || $subcommand == restore || $subcommand == stash ]]
      return
      ;;
    gh)
      if [[ ${words[index + 1]:-} == pr ]]; then
        subcommand=${words[index + 2]:-}
        [[ $subcommand == create || $subcommand == edit || $subcommand == comment || $subcommand == view || $subcommand == diff ]]
        return
      fi
      if [[ ${words[index + 1]:-} == issue ]]; then
        subcommand=${words[index + 2]:-}
        [[ $subcommand == view || $subcommand == comment ]]
        return
      fi
      ;;
  esac
  return 1
}

has_tamper_reference() {
  local segment=$1
  local match
  local tamper_write_re='(^|[[:space:]])(RELEASE_APPROVAL[[:space:]]*=|export[[:space:]]+RELEASE_APPROVAL)'
  local approval_write_command_re='(^|[[:space:]])(cp|mv|install|ln|touch|truncate|dd|tee)([[:space:]]|$)'
  local approval_file
  # shellcheck disable=SC2016 # literal "$(" to detect command substitution
  local command_substitution='$('
  local backtick='`'
  match=$(strip_match_quotes "$segment")
  approval_reference_in "$match" || return 1
  approval_file=$(resolved_approval_file)
  if [[ $match =~ $tamper_write_re || $match =~ $approval_write_command_re ]]; then
    return 0
  fi
  if [[ $match == *">"*"$approval_file"* || $match == *">"*release-approval* || $match == *tee*"$approval_file"* || $match == *tee*release-approval* ]]; then
    return 0
  fi
  if [[ $segment != *"$command_substitution"* && $segment != *"$backtick"* ]] && is_production_script_reference "$match"; then
    return 1
  fi
  if is_readonly_reference "$match"; then
    return 1
  fi
  return 0
}

is_readonly_psql() {
  local segment=$1
  local match
  local lower
  local sql
  local forbidden_re='(^|[^[:alnum:]_])(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|vacuum|reindex|cluster|call|do|comment|refresh|lock)([^[:alnum:]_]|$)'
  local command_re='(^|[[:space:]])(--command|-c)(=|[[:space:]])'
  local readonly_start_re='^[[:space:]]*(select|with|show|explain|table|values)([[:space:];]|$)'

  match=$(strip_match_quotes "$segment")
  lower=$(printf '%s' "$match" | tr '[:upper:]' '[:lower:]')

  [[ $lower =~ (^|[^[:alnum:]_])psql([[:space:]]|$) ]] || return 1
  [[ ! $lower =~ (^|[[:space:]])(-f|--file)(=|[[:space:]]) ]] || return 1
  [[ $lower =~ $command_re ]] || return 1
  [[ ! $lower =~ $forbidden_re ]] || return 1
  [[ ! $lower =~ select.*[[:space:]]into ]] || return 1
  [[ $lower != *pg_terminate_backend* && $lower != *pg_cancel_backend* ]] || return 1
  [[ $lower != *nextval* && $lower != *setval* ]] || return 1
  [[ $lower != *"set role"* ]] || return 1

  if [[ $lower == *"--command"* ]]; then
    sql=${lower#*--command}
  else
    sql=${lower#*-c}
  fi
  while [[ -n $sql && ${sql:0:1} == [[:space:]=] ]]; do
    sql=${sql:1}
  done
  sql=${sql#\"}
  sql=${sql%\"}
  sql=${sql#\'}
  sql=${sql%\'}
  sql=${sql//\\\\/\\}
  local meta_command
  local remaining=$sql
  while [[ $remaining == *\\* ]]; do
    remaining=${remaining#*\\}
    meta_command=${remaining%%[[:space:];]*}
    [[ -n $meta_command ]] || return 1
    if [[ $meta_command =~ ^d([[:alpha:]]+)?\+?$ ]]; then
      :
    else
      case $meta_command in
        l|l+|conninfo|x|timing|pset|echo|q)
          ;;
        *)
          return 1
          ;;
      esac
    fi
    remaining=${remaining#"$meta_command"}
  done
  [[ $sql =~ $readonly_start_re || $sql =~ ^[[:space:]]*\\ ]] || return 1
  return 0
}

approval_from_file() {
  local approval_file
  local first_line=""
  local today=${PRODUCTION_GATE_TODAY:-$(date +%F)}
  local line
  approval_file=$(resolved_approval_file)
  if [[ ! -r $approval_file ]]; then
    return 1
  fi
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
  if approval_from_file; then
    return 0
  fi
  return 1
}

block_or_allow() {
  local category=$1
  local reason=$2
  if has_human_approval; then
    log_decision ALLOWED "$category" "$APPROVAL_ID"
    printf 'production-gate: ALLOWED by %s (%s): %s\n' "$APPROVAL_ID" "$APPROVAL_SOURCE" "$category" >&2
    exit 0
  fi
  if [[ $APPROVAL_REASON != "no valid human approval was found" ]]; then
    reason="$reason ${APPROVAL_REASON}."
  fi
  emit_block "$category" "$reason"
}

emit_block() {
  local category=$1
  local reason=$2
  log_decision BLOCKED "$category" "-"
  printf '%s\n' \
    'BLOCKED by production-gate' \
    "Category: ${category}" \
    "Reason: ${reason} Production deploy/rollback/write needs Ryan's release approval per AGENTS.md \"Production release lane\"." \
    'Approval route: (1) open or link the PR being released; (2) for CI deploys, Ryan approves the GitHub production environment deployment (Deploy production run -> Review deployments), or for an operator action Ryan restarts the agent session with RELEASE_APPROVAL=PR-<n> or writes PR-<n> <today> to the approval file himself; (3) the agent must not set either approval.' \
    'Read-only alternatives: gh run view, curl GET /readyz, and psql SELECT.' >&2
  exit 2
}

case $TOOL_NAME in
  Write|Edit|MultiEdit|NotebookEdit)
    if approval_path_matches "$TARGET_PATH" || approval_reference_in "$TARGET_PATH"; then
      emit_block approval-tamper "The tool would write or edit the release-approval file; approval tampering cannot be overridden."
    fi
    exit 0
    ;;
esac

if [[ -n $TOOL_NAME && ! $TOOL_NAME =~ ^(Bash|bash|shell|exec_command|command|terminal|run[-_]command)$ ]]; then
  exit 0
fi

if $PARSE_BLOCK; then
  emit_block input-parse-error "${PARSE_ERROR}. The request mentions a production operation, so the gate fails closed."
fi

split_segments() {
  # Pure bash: BSD sed (macOS) does not expand \n in a replacement.
  local text=$COMMAND_TEXT
  local newline=$'\n'
  text=${text//&&/$newline}
  text=${text//||/$newline}
  text=${text//;/$newline}
  text=${text//|/$newline}
  printf '%s\n' "$text"
}

has_production_script_bypass() {
  local match_command
  local lower_command
  match_command=$(strip_match_quotes "$COMMAND_TEXT")
  lower_command=$(printf '%s' "$match_command" | tr '[:upper:]' '[:lower:]')
  [[ $lower_command =~ rollback\.sh|release_apps\.sh|migrate-only\.sh|coolify-deploy\.ts ]] || return 1
  [[ $lower_command =~ \|[[:space:]]*(/[^[:space:]]*/)?(bash|sh|zsh|dash|bun|node|xargs|eval)([[:space:]]|$) ]] && return 0
  [[ $lower_command =~ \|[[:space:]]*(env|/[^[:space:]]*/env)[[:space:]]+(/[^[:space:]]*/)?(bash|sh|zsh|dash|bun|node|xargs|eval)([[:space:]]|$) ]] && return 0
  [[ $lower_command =~ \|[[:space:]]*sudo[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(/[^[:space:]]*/)?(bash|sh|zsh|dash|bun|node|xargs|eval)([[:space:]]|$) ]] && return 0
  [[ $lower_command =~ (^|[;\|\&[:space:]])(source|\.)[[:space:]]+ ]] && return 0
  [[ $lower_command =~ (^|[;\|\&[:space:]])xargs[[:space:]] ]] && return 0
  return 1
}

is_hetzner_target_command() {
  local command=$1
  local match_command
  local lower_command
  match_command=$(strip_match_quotes "$command")
  lower_command=$(printf '%s' "$match_command" | tr '[:upper:]' '[:lower:]')
  if [[ $lower_command == *ssh://*catapulze-hetzner* ]]; then
    return 0
  fi
  if [[ $match_command =~ (^|[^[:alnum:]_-])(ssh|scp|rsync)[[:space:]] ]] && [[ $lower_command == *catapulze-hetzner* ]]; then
    return 0
  fi
  [[ $lower_command == *"docker_host=ssh://"*catapulze-hetzner* ]] && return 0
  [[ $lower_command =~ (^|[[:space:]])docker[[:space:]]+(-h|--host)(=|[[:space:]])ssh://[^[:space:]]*catapulze-hetzner ]] && return 0
  return 1
}

has_docker_write_command() {
  local command=$1
  local normalized=${command//\'/ }
  local -a words=()
  local index=0
  local word
  local subcommand

  normalized=${normalized//\"/ }
  normalized=${normalized//$'\n'/ }
  read -r -a words <<< "$normalized"
  while (( index < ${#words[@]} )); do
    word=${words[index]}
    if [[ $word != docker && $word != docker-compose ]]; then
      index=$((index + 1))
      continue
    fi

    index=$((index + 1))
    if [[ $word == docker ]]; then
      while (( index < ${#words[@]} )); do
        word=${words[index]}
        case $word in
          --config|--context|-H|--host|-l|--log-level|--tlscacert|--tlscert|--tlskey)
            index=$((index + 2))
            ;;
          --config=*|--context=*|-H=*|--host=*|-l=*|--log-level=*|--tlscacert=*|--tlscert=*|--tlskey=*)
            index=$((index + 1))
            ;;
          --debug|--tls|--tlsverify|-D|-h|--help)
            index=$((index + 1))
            ;;
          --)
            index=$((index + 1))
            break
            ;;
          -*)
            index=$((index + 1))
            ;;
          *)
            break
            ;;
        esac
      done
      if [[ ${words[index]:-} == compose ]]; then
        index=$((index + 1))
      else
        case ${words[index]:-} in
          run|restart|rm|rmi|stop|start|kill|update|cp)
            return 0
            ;;
        esac
        continue
      fi
    fi

    while (( index < ${#words[@]} )); do
      word=${words[index]}
      case $word in
        -f|-p|--file|--project-directory|--project-name|--env-file|--profile|--parallel|--progress|--ansi|--wait-timeout)
          index=$((index + 2))
          ;;
        --file=*|--project-directory=*|--project-name=*|--env-file=*|--profile=*|--parallel=*|--progress=*|--ansi=*|--wait-timeout=*)
          index=$((index + 1))
          ;;
        --compatibility|--dry-run|--all-resources|--menu|--help)
          index=$((index + 1))
          ;;
        --)
          index=$((index + 1))
          break
          ;;
        -*)
          index=$((index + 1))
          ;;
        *)
          break
          ;;
      esac
    done
    subcommand=${words[index]:-}
    case $subcommand in
      up|down|restart|rm|stop|start|pull|run|exec|kill|create|scale)
        return 0
        ;;
    esac
  done
  return 1
}

redirection_is_ignored() {
  local text=$1
  local index=$2
  local before=${text:index - 1:1}
  local after=${text:index + 1}
  after=${after#>}
  while [[ -n $after && ${after:0:1} == [[:space:]] ]]; do
    after=${after:1}
  done
  if [[ $before == 2 ]]; then
    [[ $after == '&1'* || $after == /dev/null* ]] && return 0
    return 1
  fi
  [[ $after == /dev/null* ]]
}

has_quoted_remote_redirection() {
  local text=$1
  local sql_nested_ok=${2:-false}
  local in_single=false
  local in_double=false
  local nested=false
  local escaped=false
  local index
  local character
  for ((index = 0; index < ${#text}; index++)); do
    character=${text:index:1}
    if $escaped; then
      escaped=false
      continue
    fi
    if [[ $character == "\\" && $in_single == false ]]; then
      escaped=true
      continue
    fi
    if [[ $character == "'" && $in_double == false ]]; then
      if [[ $in_single == true ]]; then
        in_single=false
        nested=false
      else
        in_single=true
      fi
      continue
    fi
    if [[ $character == '"' && $in_single == true ]]; then
      # A double quote inside a single-quoted remote command opens/closes a nested
      # quote for the remote shell (e.g. the SQL of psql -c "...").
      if [[ $nested == true ]]; then
        nested=false
      else
        nested=true
      fi
      continue
    fi
    if [[ $character == "'" && $in_double == true ]]; then
      if [[ $nested == true ]]; then
        nested=false
      else
        nested=true
      fi
      continue
    fi
    if [[ $character == '"' && $in_single == false ]]; then
      if [[ $in_double == true ]]; then
        in_double=false
        nested=false
      else
        in_double=true
      fi
      continue
    fi
    if [[ $character == '>' && ( $in_single == true || $in_double == true ) ]] && ! redirection_is_ignored "$text" "$index"; then
      if [[ $nested == true && $sql_nested_ok == true ]]; then
        continue
      fi
      return 0
    fi
  done
  return 1
}

has_heredoc_remote_redirection() {
  local command=$1
  local body
  local index
  [[ $command == *'<<'* && $command == *$'\n'* ]] || return 1
  body=${command#*$'\n'}
  for ((index = 0; index < ${#body}; index++)); do
    if [[ ${body:index:1} == '>' ]] && ! redirection_is_ignored "$body" "$index"; then
      return 0
    fi
  done
  return 1
}

has_remote_tee_write() {
  local text=$1
  local in_single=false
  local in_double=false
  local escaped=false
  local index
  local character
  local before
  local immediate_before
  local after
  local previous_index
  for ((index = 0; index < ${#text}; index++)); do
    character=${text:index:1}
    if $escaped; then
      escaped=false
      continue
    fi
    if [[ $character == "\\" && $in_single == false ]]; then
      escaped=true
      continue
    fi
    if [[ $character == "'" && $in_double == false ]]; then
      if [[ $in_single == true ]]; then
        in_single=false
      else
        in_single=true
      fi
      continue
    fi
    if [[ $character == '"' && $in_single == false ]]; then
      if [[ $in_double == true ]]; then
        in_double=false
      else
        in_double=true
      fi
      continue
    fi
    [[ ${text:index:3} == tee ]] || continue
    immediate_before=${text:index - 1:1}
    [[ -z $immediate_before || $immediate_before == [[:space:]] || $immediate_before == ';' || $immediate_before == '|' ]] || continue
    previous_index=$((index - 1))
    while (( previous_index >= 0 )) && [[ ${text:previous_index:1} == [[:space:]] ]]; do
      previous_index=$((previous_index - 1))
    done
    before=${text:previous_index:1}
    after=${text:index + 3:1}
    [[ -z $after || $after == [[:space:]] || $after == ';' || $after == '|' ]] || continue
    if [[ $in_single == true || $in_double == true || $before != '|' ]]; then
      return 0
    fi
  done
  return 1
}

check_hetzner_writes() {
  local command=$1
  local match_command
  local lower_command
  local service_write_re='(^|[^[:alnum:]_-])service[[:space:]]+[^[:space:]]+[[:space:]]+(update|restart|stop|start|reload)([[:space:]]|$)'
  local systemctl_write_re='(^|[^[:alnum:]_-])systemctl[[:space:]]+(restart|stop|start|reload)([[:space:]]|$)'
  local simple_write_re='(^|[^[:alnum:]_-])(rm|mv|kill|chmod|chown|cp|ln|truncate|dd|reboot|shutdown|mkdir|rmdir|touch|install|useradd|usermod|passwd|ufw|iptables|nft|certbot)([[:space:]]|$)'
  local package_write_re='(^|[^[:alnum:]_-])(apt|apt-get|yum|dnf)[[:space:]]+(install|remove|upgrade)([[:space:]]|$)'
  local crontab_write_re='(^|[^[:alnum:]_-])crontab[[:space:]]+(-e|-r|[^[:space:]]+)([[:space:]]|$)'
  local sed_write_re='(^|[^[:alnum:]_-])sed[[:space:]]+[^[:space:]]*-[^[:space:]]*i[^[:space:]]*([[:space:]]|$)'
  local git_write_re='(^|[^[:alnum:]_-])git[[:space:]]+(pull|checkout|reset|clean|merge)([[:space:]]|$)'
  local docker_resource_write_re='(^|[^[:alnum:]_-])docker[[:space:]]+(network|volume|system|image)[[:space:]]+(rm|prune|create)([[:space:]]|$)'
  local docker_builder_write_re='(^|[^[:alnum:]_-])docker[[:space:]]+builder[[:space:]]+prune([[:space:]]|$)'

  match_command=$(strip_match_quotes "$command")
  lower_command=$(printf '%s' "$match_command" | tr '[:upper:]' '[:lower:]')

  if [[ $lower_command =~ (^|[^[:alnum:]_-])(scp|rsync)([[:space:]]|$) ]]; then
    block_or_allow hetzner-write "scp and rsync to catapulze-hetzner are production writes."
  fi
  if [[ $lower_command =~ (^|[^[:alnum:]_-])docker[[:space:]]+exec([[:space:]]|$) ]] && ! is_readonly_psql "$command"; then
    block_or_allow hetzner-write "docker exec on catapulze-hetzner is writable unless it is a verified read-only psql SELECT."
  fi
  # A verified read-only psql may contain ">" as a SQL comparison inside its nested-quoted query.
  local sql_nested_ok=false
  if is_readonly_psql "$command"; then
    sql_nested_ok=true
  fi
  if has_quoted_remote_redirection "$command" "$sql_nested_ok" || has_heredoc_remote_redirection "$command"; then
    block_or_allow hetzner-write "The command would redirect output into the production Hetzner host or its containers."
  fi
  if has_remote_tee_write "$command"; then
    block_or_allow hetzner-write "tee on catapulze-hetzner would write to the production host or its containers."
  fi
  if has_docker_write_command "$match_command" || [[ $lower_command =~ $service_write_re || $lower_command =~ $systemctl_write_re || $lower_command =~ $simple_write_re || $lower_command =~ $package_write_re || $lower_command =~ $crontab_write_re || $lower_command =~ $sed_write_re || $lower_command =~ $git_write_re || $lower_command =~ $docker_resource_write_re || $lower_command =~ $docker_builder_write_re ]]; then
    block_or_allow hetzner-write "The command would mutate the production Hetzner host or its containers."
  fi
  if [[ $lower_command =~ (^|[^[:alnum:]_])psql([[:space:]]|$) ]] && ! is_readonly_psql "$command"; then
    block_or_allow hetzner-postgres-write "psql cannot be verified as read-only; production database writes are blocked."
  fi
}

if is_hetzner_target_command "$COMMAND_TEXT"; then
  check_hetzner_writes "$COMMAND_TEXT"
fi

if has_production_script_bypass; then
  block_or_allow production-script "The whole command would pipe, source, or indirectly execute a production script or driver."
fi

while IFS= read -r segment || [[ -n $segment ]]; do
  [[ -n ${segment//[[:space:]]/} ]] || continue
  match_segment=$(strip_match_quotes "$segment")

  if has_tamper_reference "$segment"; then
    emit_block approval-tamper "The command references RELEASE_APPROVAL or the release-approval file outside an allowed read-only inspection command."
  fi

  if [[ $match_segment =~ rollback\.sh|release_apps\.sh|migrate-only\.sh ]] && ! is_production_script_reference "$match_segment" && ! is_readonly_reference "$match_segment"; then
    block_or_allow production-script "The command would execute a production rollback, release, or migration script."
  fi
  if [[ $match_segment =~ coolify-deploy\.ts ]] && ! is_readonly_reference "$match_segment" && ! is_production_script_reference "$match_segment"; then
    block_or_allow production-driver "The command would run the repository's production Coolify deploy/rollback driver."
  fi

  lower_segment=$(printf '%s' "$match_segment" | tr '[:upper:]' '[:lower:]')
  http_client_re='(^|[^[:alnum:]_-])(curl|wget|http|https|xh)([[:space:]]|$)'
  if [[ $match_segment =~ $http_client_re ]]; then
    if [[ $match_segment =~ /api/v1/deploy([^[:alnum:]_]|$) ]]; then
      block_or_allow coolify-api-deploy "The command would call Coolify's production deploy endpoint."
    fi
    if [[ $match_segment =~ /api/v1/(applications|services|databases)/[^[:space:]/?]+/(restart|start|stop)([^[:alnum:]_]|$) ]]; then
      block_or_allow coolify-api-lifecycle "The command would change a Coolify production resource's lifecycle."
    fi
    write_method_re='(^|[[:space:]])(-x|--request)(=|[[:space:]]+)(post|put|patch|delete)([[:space:]]|$)'
    compact_method_re='(^|[[:space:]])-x(post|put|patch|delete)([[:space:]]|$)'
    write_body_re='(^|[[:space:]])(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|--upload-file|-T|--post-data|--post-file)(=|[[:space:]]|$)'
    wget_method_re='(^|[[:space:]])--method(=|[[:space:]]+)(post|put|patch|delete)([[:space:]]|$)'
    httpie_method_re='(^|[[:space:]])(http|https)[[:space:]]+(post|put|patch|delete)[[:space:]]+[^[:space:]]*/api/v1/'
    xh_method_re='(^|[[:space:]])xh[[:space:]]+(post|put|patch|delete)[[:space:]]+'
    if [[ $lower_segment == */api/v1/* ]] && { [[ $lower_segment =~ $write_method_re ]] || [[ $lower_segment =~ $compact_method_re ]] || [[ $lower_segment =~ $write_body_re ]] || [[ $lower_segment =~ $wget_method_re ]] || [[ $lower_segment =~ $httpie_method_re ]] || [[ $lower_segment =~ $xh_method_re ]]; }; then
      block_or_allow coolify-api-write "The command would send a write request to a Coolify API path."
    fi
  fi

  if [[ $match_segment =~ gh[[:space:]]+workflow[[:space:]]+run ]] && [[ $match_segment == *deploy-production* || $match_segment == *"Deploy production"* ]]; then
    block_or_allow github-production-dispatch "The command would dispatch the Deploy production workflow."
  fi
  if [[ $match_segment =~ gh[[:space:]]+api[[:space:]] ]] && [[ $match_segment == */actions/workflows/deploy-production.yml/dispatches* ]]; then
    block_or_allow github-production-dispatch "The command would dispatch Deploy production through the GitHub API."
  fi
  if [[ $match_segment =~ gh[[:space:]]+run[[:space:]]+rerun ]] && [[ $match_segment == *deploy-production* || $match_segment == *"Deploy production"* ]]; then
    block_or_allow github-production-dispatch "The command would rerun a named Deploy production workflow."
  fi

done < <(split_segments)

exit 0
