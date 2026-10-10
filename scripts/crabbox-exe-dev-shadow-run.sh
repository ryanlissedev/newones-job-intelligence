#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_CRABBOX_VERSION="0.62.0"
readonly EXPECTED_CRABBOX_ARCHIVE_SHA256="7e742950103248c976b429c3ceab6fc6c37e091c96cfd47b473c29565f68f2dc"
readonly EXPECTED_CRABBOX_BINARY_SHA256="a3efd851358ada2624c8cccf3254a64fab52afe8e8e2c3ec399db9c707a06d01"
readonly MATERIALIZATION_CLEANUP_ATTEMPTS=3
readonly MATERIALIZATION_CLEANUP_RETRY_DELAY_SECONDS="0.05"

dry_run="false"
for argument in "$@"; do
  case "$argument" in
    -id | --id | -id=* | --id=*)
      printf 'exe.dev shadow: existing-lease --id arguments are forbidden for a cold run\n' >&2
      exit 1
      ;;
    -dry-run | --dry-run)
      dry_run="true"
      ;;
  esac
done

if [[ "${CRABBOX_EXE_DEV_CONTROL_HOST:-}" != "exe.dev" ]]; then
  printf 'exe.dev shadow: set CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev to approve the configured control host\n' >&2
  exit 1
fi

if [[ "${EXE_DEV_REGION:-}" != "FRA" ]]; then
  printf 'exe.dev shadow: set EXE_DEV_REGION=FRA before starting the configured cohort\n' >&2
  exit 1
fi

repository_git() {
  (
    unset GIT_ALTERNATE_OBJECT_DIRECTORIES
    unset GIT_COMMON_DIR
    unset GIT_CONFIG
    unset GIT_CONFIG_COUNT
    unset GIT_CONFIG_PARAMETERS
    unset GIT_DIR
    unset GIT_GRAFT_FILE
    unset GIT_IMPLICIT_WORK_TREE
    unset GIT_INDEX_FILE
    unset GIT_NO_REPLACE_OBJECTS
    unset GIT_OBJECT_DIRECTORY
    unset GIT_PREFIX
    unset GIT_REPLACE_REF_BASE
    unset GIT_SHALLOW_FILE
    unset GIT_WORK_TREE
    # A refs/replace entry for HEAD would let rev-parse record the original
    # object id while archive materializes the replacement tree. Disable
    # replacement processing for every source-identity and archive call.
    git --no-replace-objects "$@"
  )
}

materialized_git() {
  (
    unset GIT_ALTERNATE_OBJECT_DIRECTORIES
    unset GIT_COMMON_DIR
    unset GIT_CONFIG
    unset GIT_CONFIG_COUNT
    unset GIT_CONFIG_PARAMETERS
    unset GIT_DIR
    unset GIT_GRAFT_FILE
    unset GIT_IMPLICIT_WORK_TREE
    unset GIT_INDEX_FILE
    unset GIT_NO_REPLACE_OBJECTS
    unset GIT_OBJECT_DIRECTORY
    unset GIT_PREFIX
    unset GIT_REPLACE_REF_BASE
    unset GIT_SHALLOW_FILE
    unset GIT_WORK_TREE
    cd "$materialized_workspace"
    git --no-replace-objects "$@"
  )
}

if ! workspace_root="$(repository_git rev-parse --show-toplevel)"; then
  printf 'exe.dev shadow: could not resolve the source Git workspace\n' >&2
  exit 1
fi

source_git_sha="$(repository_git -C "$workspace_root" rev-parse --verify HEAD)"
if [[ ! "$source_git_sha" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  printf 'exe.dev shadow: could not bind the run to a full Git commit SHA\n' >&2
  exit 1
fi

source_git_state="clean"
if ! source_git_status="$(repository_git -C "$workspace_root" status --porcelain=v1 --untracked-files=all)"; then
  printf 'exe.dev shadow: could not determine the source Git state\n' >&2
  exit 1
fi
if [[ -n "$source_git_status" ]]; then
  printf 'exe.dev shadow: source workspace must be clean before materialization\n' >&2
  exit 1
fi

for required_tool in bun crabbox python3 rsync tar; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    printf 'exe.dev shadow: required local tool is missing: %s\n' "$required_tool" >&2
    exit 1
  fi
done

monotonic_ms() {
  python3 -c 'import time; print(time.monotonic_ns() // 1_000_000)'
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

crabbox_path="$(command -v crabbox)"
crabbox_provenance_file="${CRABBOX_PROVENANCE_FILE:-${crabbox_path}.provenance}"
expected_crabbox_binary_sha256="$EXPECTED_CRABBOX_BINARY_SHA256"
if [[ ! -r "$crabbox_provenance_file" ]]; then
  printf 'exe.dev shadow: Crabbox provenance file is missing: %s\n' \
    "$crabbox_provenance_file" >&2
  exit 1
fi

provenance_archive_sha256="$(awk -F= '$1 == "archive_sha256" { print $2; exit }' "$crabbox_provenance_file")"
provenance_binary_sha256="$(awk -F= '$1 == "binary_sha256" { print $2; exit }' "$crabbox_provenance_file")"
if [[ "$provenance_archive_sha256" != "$EXPECTED_CRABBOX_ARCHIVE_SHA256" ]]; then
  printf 'exe.dev shadow: Crabbox provenance archive digest does not match the pinned release\n' >&2
  exit 1
fi
actual_crabbox_binary_sha256="$(sha256_file "$crabbox_path")"
if [[ ! "$provenance_binary_sha256" =~ ^[0-9a-f]{64}$ || "$provenance_binary_sha256" != "$expected_crabbox_binary_sha256" || "$actual_crabbox_binary_sha256" != "$expected_crabbox_binary_sha256" ]]; then
  printf 'exe.dev shadow: Crabbox binary digest does not match its provenance file\n' >&2
  exit 1
fi

crabbox_version="$(crabbox --version)"
if [[ "$crabbox_version" != "$EXPECTED_CRABBOX_VERSION" ]]; then
  printf 'exe.dev shadow: expected Crabbox %s, found %s\n' \
    "$EXPECTED_CRABBOX_VERSION" "$crabbox_version" >&2
  exit 1
fi

materialization_root="$(mktemp -d "${TMPDIR:-/tmp}/ji-exe-dev-shadow.XXXXXX")"
materialized_workspace="${materialization_root}/workspace"
source_archive="${materialization_root}/source.tar"
mkdir -p "$materialized_workspace"

# shellcheck disable=SC2329 # invoked by the EXIT trap cleanup helper
cleanup_materialization() {
  local cleanup_status=0
  local attempt
  for ((attempt = 1; attempt <= MATERIALIZATION_CLEANUP_ATTEMPTS; attempt += 1)); do
    cleanup_status=0
    rm -rf -- "$materialization_root" 2>/dev/null || cleanup_status=$?
    if [[ "$cleanup_status" -eq 0 ]]; then
      return 0
    fi
    if [[ "$attempt" -lt "$MATERIALIZATION_CLEANUP_ATTEMPTS" ]]; then
      sleep "$MATERIALIZATION_CLEANUP_RETRY_DELAY_SECONDS"
    fi
  done
  printf 'exe.dev shadow: failed to clean up materialization workspace after %s attempts: %s\n' \
    "$MATERIALIZATION_CLEANUP_ATTEMPTS" "$materialization_root" >&2
  return "$cleanup_status"
}

# shellcheck disable=SC2329 # invoked indirectly by the EXIT trap
cleanup_on_exit() {
  local original_exit_status="$?"
  cleanup_materialization || true
  return "$original_exit_status"
}
trap cleanup_on_exit EXIT

# Bash defers a trapped signal until a foreground child returns, so a bare
# INT/TERM handler would let a paid Crabbox run continue to completion. Run
# Crabbox as a managed child, forward the signal to it, and exit with the
# signal status once it has been reaped.
crabbox_pid=""
received_signal=""
# preflight: no child exists yet, so a signal must stop the launcher before
#   any paid work starts. starting: the child was just spawned and its pid is
#   about to be recorded; the launcher re-checks received_signal right after.
#   running: forward the signal to the managed child.
launch_state="preflight"
signal_exit_status() {
  case "$1" in
    INT) printf '130' ;;
    *) printf '143' ;;
  esac
}
# shellcheck disable=SC2329 # invoked indirectly by the INT/TERM traps
forward_signal() {
  received_signal="$1"
  case "$launch_state" in
    preflight)
      exit "$(signal_exit_status "$received_signal")"
      ;;
    running)
      if [[ -n "$crabbox_pid" ]] && kill -0 "$crabbox_pid" 2>/dev/null; then
        kill -s "$received_signal" "$crabbox_pid" 2>/dev/null || true
      fi
      ;;
    *) ;;
  esac
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM

materialization_started_ms="$(monotonic_ms)"
repository_git -C "$workspace_root" archive \
  --format=tar \
  --output="$source_archive" \
  "$source_git_sha"
tar -xf "$source_archive" -C "$materialized_workspace"
materialization_ended_ms="$(monotonic_ms)"

input_preflight_started_ms="$(monotonic_ms)"
(
  cd "$materialized_workspace"
  bun scripts/check-secrets-scan.ts \
    --root . \
    --write-manifest .crabbox-input-manifest.sha256
)
input_preflight_ended_ms="$(monotonic_ms)"

# Crabbox sync is Git-based when sync.gitSeed is true, so seed the
# materialized input with a throwaway repository. Crabbox may fingerprint this
# synthetic commit, while the evidence fingerprint remains bound to the
# explicitly exported CRABBOX_SOURCE_GIT_SHA and CRABBOX_SOURCE_GIT_STATE.
materialized_git init -q
materialized_git add -A
materialized_git \
  -c user.name="crabbox-launcher" \
  -c user.email="crabbox-launcher@catapulze.invalid" \
  -c commit.gpgsign=false \
  commit -q -m "materialized ${source_git_sha}"

source_manifest="${materialized_workspace}/.crabbox-input-manifest.sha256"
source_manifest_digest="$(sha256_file "$source_manifest")"
source_manifest_file_count="$(wc -l <"$source_manifest" | tr -d ' ')"

export CRABBOX_SOURCE_GIT_SHA="$source_git_sha"
export CRABBOX_SOURCE_GIT_STATE="$source_git_state"
export CRABBOX_CLIENT_VERSION="$crabbox_version"
export CRABBOX_SOURCE_MANIFEST_SHA256="sha256:${source_manifest_digest}"
export CRABBOX_SOURCE_MANIFEST_FILE_COUNT="$source_manifest_file_count"
export CRABBOX_SOURCE_MATERIALIZATION_DURATION_MS="$((materialization_ended_ms - materialization_started_ms))"
export CRABBOX_SOURCE_PREFLIGHT_DURATION_MS="$((input_preflight_ended_ms - input_preflight_started_ms))"

# Each attempt is authoritative for the evidence destination. Clear it before
# Crabbox starts so a failure at any point (provisioning, sync, interrupt) can
# never leave a prior attempt's report behind to be mistaken for this run's.
materialized_evidence="${materialized_workspace}/.artifacts/crabbox/exe-dev-shadow"
workspace_evidence="${workspace_root}/.artifacts/crabbox/exe-dev-shadow"
rm -rf -- "$workspace_evidence"

if [[ -n "$received_signal" ]]; then
  exit "$(signal_exit_status "$received_signal")"
fi
set +e
launch_state="starting"
(
  cd "$materialized_workspace" || exit 1
  exec crabbox job run "$@" exe-dev-shadow
) &
crabbox_pid=$!
launch_state="running"
# A signal that landed between the spawn and the pid capture was only
# recorded; deliver it to the child now.
if [[ -n "$received_signal" ]]; then
  kill -s "$received_signal" "$crabbox_pid" 2>/dev/null || true
fi
wait "$crabbox_pid"
run_exit_status=$?
# A trapped signal interrupts wait before the child exits; keep reaping until
# the child is gone so its real exit status is observed.
while kill -0 "$crabbox_pid" 2>/dev/null; do
  wait "$crabbox_pid"
  run_exit_status=$?
done
crabbox_pid=""
set -e

if [[ -d "$materialized_evidence" ]]; then
  mkdir -p "$workspace_evidence"
  rsync -a --delete "${materialized_evidence}/" "${workspace_evidence}/"
fi

if [[ "$dry_run" == "false" && "$run_exit_status" -eq 0 ]]; then
  validation_status_file="${workspace_evidence}/validation-exit-status.txt"
  if [[ ! -f "$validation_status_file" ]]; then
    printf 'exe.dev shadow: successful artifact transport did not return validation status\n' >&2
    run_exit_status=1
  else
    validation_exit_status="$(tr -d '[:space:]' <"$validation_status_file")"
    if [[ ! "$validation_exit_status" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
      printf 'exe.dev shadow: returned validation status is invalid\n' >&2
      run_exit_status=1
    else
      run_exit_status="$validation_exit_status"
    fi
  fi
fi

if [[ -n "$received_signal" ]]; then
  exit "$(signal_exit_status "$received_signal")"
fi
exit "$run_exit_status"
