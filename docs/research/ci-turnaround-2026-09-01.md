# CI turnaround: measured baseline and optimisation (2026-09-01)

Goal: cut wall-clock time to green on the `CI` workflow **without weakening any
gate**. Every check that ran before this change still runs, at the same
strictness — no `continue-on-error`, no reduced test scope, no new skip paths.
The migration-upgrade suite (RJC-395) and the `changes` filter semantics
(RJC-370 scar) are untouched.

## 1. Baseline — last 5 successful `CI` runs on `main` (2026-09-01)

Measured from the GitHub API (`gh run view --json jobs`; step durations are
`completedAt - startedAt`). All runs: queue time (`createdAt → startedAt`)
was **0s** at run level; job pickup after run creation was 2–11s. Runners are
not the bottleneck — compute on the critical path is.

| Run ID | Total wall | verify job | gate | Build | Start PG | Install Qlty | Bun cache restore |
|---|---|---|---|---|---|---|---|
| 33475747859 | 2m48s | 2m36s | 76s | 47s | 11s | 6s | 6s |
| 33475125255 | 2m54s | 2m43s | 67s | 38s | 24s | 10s | 5s |
| 33474366263 | 3m03s | 2m34s | 73s | 43s | 17s | 5s | 6s |
| 33473704593 | 2m57s | 2m45s | 74s | 49s | 12s | 6s | 7s |
| 33469764828 | ~2m45s | 2m38s | 69s | 48s | 11s | 6s | 7s |

Parallel jobs: `changes` ~6s, `postgres-restore-drill` 50–80s (finishes well
before `verify`; never on the critical path). Critical path = `changes` →
`verify` (checkout/setup ~25s + PG start + gate + build + teardown).

### Where the 76s gate goes (from run 33475747859's own performance artifact,
`ci-performance-33475747859-1`, produced by `scripts/performance/measure.ts`)

| Gate phase | Duration |
|---|---|
| check-types (turbo, uncached in CI) | **36.1s** |
| qlty check --all | 18.8s |
| bun test (~950 tests, Postgres-bound) | 13.9s |
| ultracite check | 2.4s |
| performance-scripts typecheck | 2.3s |
| ci-metrics typecheck | 0.9s |
| layering, secrets, compose guards, migration-DB prep | <1.5s combined |
| **gate total** | **75.5s** |

The gate now also prints `gate: phase '<label>' took Ns` after every phase
(`tools/quality/gate.sh`), so any future CI log or local run shows this
breakdown without downloading the artifact.

## 2. Levers evaluated

### Adopted

1. **Build moved out of `verify` into a parallel `build` job.** Nothing inside
   `verify` consumes the build output (the steps after it were teardown and
   artifact upload); it was pure compile-proof serialised onto the critical
   path. Measured cost inside verify: 38–49s. New job pays its own setup
   (~20s checkout+bun+caches+install) but runs alongside `verify` and is far
   shorter than it, so it never becomes the critical path. **Expected wall
   win: ~40–45s.** The same check still runs on the same triggers with the
   same `changes` gating — it is relocated, not relaxed. Its perf records
   upload as `ci-performance-build-<run>-<attempt>`; `scripts/ci-metrics`
   reads jobs from the API, so the new job is picked up automatically.

2. **Turborepo cache persisted across runs via `actions/cache`.** CI reported
   "Remote caching disabled" every run; `check-types` (36.1s) and `build`
   (47s) re-derived everything from scratch. Both jobs now pin
   `TURBO_CACHE_DIR: .turbo/cache` and cache that directory keyed
   `turbo-<job>-<os>-<sha>` with a `turbo-<job>-<os>-` restore key (standard
   save-per-commit / restore-latest pattern; GH cache scoping means `main`
   runs populate entries readable by every PR). No Vercel account, no paid
   service. This is not a strictness change: turbo replays a task only when
   the hash of its inputs (all package files, lockfile, and — added to
   `turbo.json` `globalDependencies` — the root `tsconfig.json`) is
   identical, the same semantics the repo already relies on locally (11/11
   cached). **Expected: check-types 36s → ~2–5s and build 47s → ~10s on
   warm cache; first run after merge is the cache-miss run.**

3. **Postgres image pre-pull in the background.** `Start isolated PostgreSQL`
   varied 11–24s; the pull of the digest-pinned image is serialised inside
   it. A `nohup docker compose pull -q postgres &` right after checkout
   overlaps the pull with the ~25s of cache/install steps. **Expected win:
   5–10s**, and it removes the 24s outlier.

4. **Gate instrumentation** (`tools/quality/gate.sh`): per-phase elapsed
   seconds printed unconditionally. Zero-cost; makes every future
   optimisation measurable from the log alone.

### Evaluated, not adopted

- **`concurrency` + `cancel-in-progress`** — already present on `ci.yml`,
  `claude-code-review.yml`, `react-doctor.yml`, `bench-search.yml`. Nothing
  to add.
- **Qlty install caching (6–10s).** The qlty-action installs the latest CLI
  each run; caching the binary would freeze the version and silently drift
  from what contributors run. 6–10s is not worth a version-pinning scheme in
  this pass; revisit if the action grows a version input we can key a cache
  on.
- **Test sharding / splitting `verify` into lint+types | unit | DB jobs.**
  After the turbo cache lands, the gate's residual is qlty 19s + tests 14s +
  ultracite 2s ≈ 35s — smaller than the ~20s per-job setup tax each new
  shard pays, and the Postgres specs share one database (RJC-369), so DB
  shards need template-DB isolation work. Negative result: at this suite
  size, sharding costs more wall clock than it saves. Re-evaluate when the
  DB-bound test phase alone exceeds ~60s.
- **bun install cold path** — restore-keys already cover it; warm restore is
  6s and install itself 0–3s. Nothing to fix.

## 3. Expected after-state (to be confirmed on real runs)

| | Baseline (median) | Expected cold turbo cache | Expected warm turbo cache |
|---|---|---|---|
| Wall clock to green | ~2m52s | ~2m10s | **~1m40s–1m55s** |
| verify job | ~2m38s | ~1m55s | ~1m25s–1m40s |
| build (now parallel) | (inside verify) | ~1m15s | ~45s |

### Measured on PR #111 — cache-MISS run (run 33483731056, 2026-09-01)

First real run of the changed workflow, and the first real output of the gate
instrumentation. Turbo cache was a clean miss (`Cache not found for input
keys: turbo-verify-Linux-…`), so this is the *worst case* for the new layout.

| | Baseline (median) | PR #111 miss run |
|---|---|---|
| Wall clock to green | ~2m52s | **2m25s** (07:46:09 → 07:48:40) |
| verify job | ~2m38s | **2m21s** (gate-only; build removed) |
| build (parallel job) | (inside verify, 38–49s) | **61s** — off the critical path |
| postgres-restore-drill | 50–80s | 54s |
| changes | ~6s | 4s |

Gate phases as printed by the new instrumentation (verify log):

| Gate phase | Baseline (artifact) | Miss run (log) |
|---|---|---|
| typecheck | 36.1s | 28s (miss — full run, as expected) |
| qlty | 18.8s | 23s |
| test | 13.9s | 18s |
| ultracite | 2.4s | 3s |
| performance-typecheck | 2.3s | 2s |
| ci-metrics-typecheck | 0.9s | 1s |
| layering / secrets / compose guards | <1.5s | 0s each |

Cache mechanics confirmed from the run log: restore looked up
`turbo-verify-Linux-<sha>` then `turbo-verify-Linux-` and found nothing
(clean miss); post-steps saved `turbo-verify-Linux-63d2a30…` (3.6 KiB —
check-types has no outputs, so the entry is replay logs only) and
`turbo-build-Linux-63d2a30…` (22.5 MiB of build outputs). `Start isolated
PostgreSQL` was 23s this run — the background pre-pull step itself took 1s
but the pull had not finished before compose needed it; see the hit run for
whether the overlap pays on a warmer path. All checks green: verify, build,
postgres-restore-drill, CodeRabbit, Claude review.

Note for the warm measurement: the follow-up commit is docs-only, but
`dorny/paths-filter` on `pull_request` evaluates the whole PR diff (which
includes `ci.yml`), so `changes.outputs.code` stays `true` and the full
gate runs — the warm numbers are real, not a skip.

### What the cache-HIT run must show (the lead pushes; read these numbers)

1. Turbo prints `FULL TURBO` / cache-hit lines; `gate: phase 'typecheck'`
   drops to single digits (miss run: 28s).
2. `build` job total well under a minute (miss run: 61s).
3. `Start isolated PostgreSQL` duration vs the miss run's 23s — tells us
   whether the background pre-pull pays.
4. `postgres-restore-drill` and the migration-upgrade gate lines unchanged
   (`gate: migration-upgrade suite will run against database …`).
5. If typecheck is NOT single digits, the likely cause is a restore-key
   miss across SHAs — check the `Restore Turborepo cache` log for which
   key matched.

## 4. Runner class: Blacksmith

- Current: `ubuntu-latest` GitHub-hosted (4 vCPU on this repo per the perf
  artifact's `cpuCount: 4`). **The repo is PUBLIC, so GitHub-hosted runner
  minutes cost €0 today.**
- Volume: ~1,497 workflow runs in the 30 days to 2026-09-01 (all workflows).
  A green CI run consumes ≈4–5 job-minutes; rough order 5–8k billable-shaped
  minutes/month across workflows.
- Blacksmith pricing (blacksmith.sh, checked 2026-09-01): 2 vCPU x64 at
  **$0.004/min**, with **3,000 free 2vCPU-minutes/month per org**; claims ~2×
  faster CPUs. At this repo's volume that is roughly $10–25/month after the
  free tier — against a current cost of **$0** and a post-optimisation wall
  clock already under ~2 minutes.
- Numbers say: the measured profile is ~2.5 min of compute of which ~1 min
  disappears via caching/parallelism in this change; a 2× CPU would shave
  perhaps another 30–40s of the remainder for a new recurring bill and a new
  vendor. Decision is Ryan's; nothing here signs up for anything.

## 5. Advisory checks vs merge latency

**There is no branch protection and no rulesets on `main`** (API returns
"Branch not protected"; rulesets list is empty) — *no* check is formally
required for merge. Everything a human waits on is policy, not enforcement.

| Check | Trigger | Recent durations | Nature |
|---|---|---|---|
| CI | every PR/push | 2m56s–3m11s (now shrinking) | The real gate |
| Claude Code Review | every PR | 68s, 69s, **10m33s** | Advisory; the 10m tail is the slowest thing on a PR when it triggers a full review |
| React Doctor | PRs touching web paths | 28s | Advisory, path-filtered |
| CI Metrics | after CI (workflow_run) | post-merge, off the PR path | Telemetry |
| CodeRabbit | GitHub App (not a repo workflow) | not visible in Actions | Advisory |

If PRs feel slow to merge, the wait is usually **Claude Code Review's long
tail**, not CI. That is a policy call, not a code fix: either merge on CI
green and read the review async, or add a ruleset that names exactly which
checks are required (recommended anyway — today nothing stops a merge with a
red CI). If required checks are added later, note that `build` and
`postgres-restore-drill` use job-level `if:` on the `changes` filter; GitHub
counts a skipped job as satisfying a required check, so docs-only PRs still
merge.

## 6. Reproduction

- Job/step durations: `gh run view <id> --json jobs` on the run IDs in §1.
- Gate phases: download artifact `ci-performance-<run>-<attempt>` and
  aggregate `durationMs` per `label`, or read the new `gate: phase '<label>'
  took Ns` log lines.
- Run volume: `gh api 'repos/ryanlissedev/rsp-job-intelligence/actions/runs?created=>2026-08-01&per_page=1' --jq .total_count`.
