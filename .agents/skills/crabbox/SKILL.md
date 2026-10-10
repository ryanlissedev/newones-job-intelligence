---
name: crabbox
description: "Run Catapulze Job Intelligence validation on the configured exe.dev shadow lane with Crabbox. Use for remote clean-room or Docker validation when local resources should stay bounded."
license: MIT
---

# Crabbox for Job Intelligence

This repository uses Crabbox `v0.62.0` with the direct `exe-dev` provider. GitHub CI remains the required merge gate; this lane is opt-in, non-blocking, and must not run untrusted fork code.

Before any paid `exe-dev-shadow` operation:

1. Inspect `.crabbox.yaml` and confirm `crabbox --version` is `0.62.0`. The launcher also requires `${CRABBOX_PROVENANCE_FILE:-$(command -v crabbox).provenance}` to contain the pinned release archive digest and the matching installed-binary digest; it fails closed when either is missing or mismatched.
2. Read the existing exe.dev account region with `ssh -o BatchMode=yes exe.dev whoami --json`. Do not change the operator's region during a preflight; repository config cannot set an exe.dev region. A region change requires separate operator approval and a concrete reason.
3. Confirm the readback region is `FRA` before any paid run. Do not start a lease when the readback differs.
4. Export `CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev` for every launcher process. This non-secret value explicitly approves the configured SSH credential destination; it does not approve a lease or cost.
5. Export `EXE_DEV_REGION=FRA` for the Crabbox process. The shadow script requires this explicit cohort assertion and records it in the execution fingerprint.
6. Obtain explicit cost approval for the proposed 2 CPU, 8 GB RAM, 40 GB disk VM. Authentication and region selection are not permission to create a lease.
7. Inspect the plan with `CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev EXE_DEV_REGION=FRA scripts/crabbox-exe-dev-shadow-run.sh --dry-run`.

Run the bounded shadow lane with:

```sh
CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev \
  EXE_DEV_REGION=FRA \
  scripts/crabbox-exe-dev-shadow-run.sh
```

The job uses `stop: always`. After it returns, read back provider inventory and confirm the lease was removed. If execution is interrupted, use the exact slug or `cbx_` lease ID from Crabbox state and run `crabbox stop` before continuing.

The launcher validates and exports the caller's full Git SHA plus clean/dirty state. Crabbox's env allowlist transports that non-secret source identity when `.git` is unavailable after manifest sync.

This named job is cold-only: it creates a new lease, starts from an unprimed repository workspace, and does not claim that the provider image cache is empty. Do not run it with `--id` and do not relabel it as warm. A genuine warm cohort requires a separate reviewed existing-lease flow.

On success, Crabbox downloads the required ADR-0001 evidence into `.artifacts/crabbox/exe-dev-shadow/`: phase JSONL with monotonic durations, an execution fingerprint containing the Bun lockfile and repository-correctness dataset digests, Markdown report, Bun JUnit XML, and a SHA-256 manifest. Treat a missing required artifact as a failed shadow run. Crabbox's artifact bundle remains the provider-side run record.

Never sync real `.env*` files, pass secrets on the command line, use `--reclaim` without an intentional ownership review, or treat an image build as runtime proof. The ordered sync rules exclude every `.env*` path and re-include only exact tracked `.env.example` templates needed by the shadow script, including when private Git seeding is unavailable. The script checks the live Compose services separately.
