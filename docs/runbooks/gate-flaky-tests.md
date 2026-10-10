# Gate: flaky and slow tests

The pre-push gate (`tools/quality/gate.sh`, run by lefthook) executes the whole
`bun test` suite in one process after `ultracite`, `qlty` and `check-types`.
A test that is fine on an idle laptop can exceed Bun's **5000 ms default
per-test budget** while the gate (or a parallel worktree) saturates the CPU.
This runbook is where such tests are tracked and where the rules for fixing
them live. `git push --no-verify` is never the fix.

## Rules

1. **Size the budget to what the test forks, not to the work.** A test that
   spawns a Bun runtime, a Docker container, or a network round-trip must pass
   an explicit `{ timeout }` with a comment stating the measured cost it is
   sized for. The 5 s default is for in-process tests only.
2. **Prefer in-process over spawn.** If the thing under test can be called as a
   function, test it that way and keep at most one spawned "smoke" run to prove
   the argv/exit-code path. Each `bun <file>.ts` spawn re-transpiles the
   workspace it imports (1.5 s warm, 3.4 s cold measured for
   `benchmarks/relevance/export-judgments.ts` on an M-series laptop).
3. **Reproduce under load before declaring a test fixed.** Run the suite in a
   loop while the gate's heaviest phase runs beside it:

   ```bash
   ( while true; do bun run check-types >/dev/null 2>&1; done ) & LOAD=$!
   for i in 1 2 3 4 5; do bun test <path-or-filter>; echo "exit=$?"; done
   kill "$LOAD"
   ```

   Record the wall time of the slowest run in the ledger below. Run the test
   command unpiped (or with `set -o pipefail`) so the exit code you read is the
   test's, not `tail`'s.
4. **Non-DB specs can skip the Postgres preload.** `bunfig.toml` preloads
   `tools/postgres/test-isolation.ts`, which creates a throwaway database before
   the first test and throws on an auth failure. To iterate on a subset that
   never touches Postgres, set `DATABASE_TEST_URL` to any non-empty value
   (`DATABASE_TEST_URL=postgresql://preload-skipped bun test benchmarks/relevance`);
   the preload then no-ops. Never do this for the full gate.
5. **One row per incident, kept after the fix.** The ledger is the history of
   what the gate has tolerated and why; delete rows only when the test itself is
   deleted.
6. **A prefix-less `(unnamed)` hook timeout is the preload's global hook,
   charged to the last file.** Bun prints a timed-out `beforeAll`/`afterAll`
   as `(fail) <describe> > (unnamed)`. A hook registered outside any
   `describe` — the `afterAll` in `tools/postgres/test-isolation.ts` that
   drops the isolated database — has no prefix and is reported under
   whichever spec file ran last, which is the deepest test file in the repo
   because Bun walks directories breadth-first. Read that line as "the
   teardown was slow", not as a bug in the file it appears under, and check
   the `test-isolation: dropped '<db>' in <n> ms` line printed just above it.

## Ledger

| Date | Test | Symptom | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-09-03 | `benchmarks/relevance/export-judgments.spec.ts` › "writes a deterministic CSV + md pair and reruns byte-identical" | Timed out twice in the pre-push gate (5000 ms and 10092 ms observed) while `check-types` ran; green when run alone. | The test spawned `bun benchmarks/relevance/export-judgments.ts` twice; each spawn boots a fresh runtime that transpiles `@ji/application`, `@ji/connectors`, `@ji/search`, `@ji/domain` and replays every connector over its fixtures (1.5–3.4 s each idle). Two spawns under a 5 s default budget left no headroom under load. The Postgres preload was not involved: it runs once per process, before any test. | `export-judgments.ts` now exports `exportJudgments()`; the determinism test calls it twice in-process in a `mkdtemp` dir. One spawned smoke test remains with an explicit 60 s budget. Verified 10× `bun test benchmarks/relevance` (two 5× loops) while `turbo run check-types --force` looped, load avg 6.6–12.9: 26/26 green every run. Spawned smoke test max 14.1 s (would have failed the old 5 s default on its own), in-process determinism test max 0.55 s. | fixed |
| 2026-09-04 | `apps/web/src/features/job-intelligence/rest/capability-client.spec.ts` › `(unnamed)` | Once in the pre-push gate (full suite, `--max-concurrency 2`, macOS, `check-types` beside it): `(fail) (unnamed) [5021.37ms]` / `a beforeEach/afterEach hook timed out for this test`; tally 1256 pass / 1 fail; green 3/3 when run alone. | Not this spec. Its own hooks are synchronous one-liners that swap `globalThis.fetch`, and its test passed (it is one of the 1256; the `(unnamed)` entry is an extra synthetic test). Per rule 6 the timed-out hook is the preload's global `afterAll` in `tools/postgres/test-isolation.ts`: a fresh admin connection plus `DROP DATABASE … WITH (FORCE)`, which terminates every backend still attached, waits for them to exit, and forces an immediate checkpoint — a network round-trip running under Bun's 5 s in-process default with no explicit budget. This spec is the deepest test file in the repo (7 path segments), so Bun's breadth-first walk always runs it last and it takes the blame. Rule 4 does not apply: the preload's setup is top-level `await` before the first file and is charged to no test, and there is no per-spec opt-out. Rule 1 does not apply to the spec either: in-process, ~1 ms hooks keep the default. | Attribution verified deterministically before changing anything: a synthetic 6 s preload `afterAll` reproduces the exact output line under the last of two trivial files, and the real teardown reproduces it under this very spec with `bun test --timeout 100 <spec>` (DROP measured at 123.6 ms in the Postgres log; the spec's own test passes in the same run). `test-isolation.ts` now passes an explicit 60 s `{ timeout }` to its `afterAll` and logs the teardown's wall time and attached-backend count; the same `--timeout 100` run is green with it. Rule 3 on a 4-core Linux box with a local Postgres 16, mirroring the gate's test phase (`REQUIRE_DATABASE_TESTS=1`, migration-upgrade DB prepared): pre-fix 1 idle + 5 loaded full-suite runs, DROP 104–549 ms, load avg up to 5.6, never past 5 s here — the macOS incident had Postgres in Docker Desktop (CPU-capped at 2, virtualised disk), whose checkpoint cost this box does not reproduce. Post-fix, 5× full suite under the same check-types loop (load avg up to 5.5): teardown 114–270 ms wall per the new log line, DROP 90–249 ms; plus 3× with an fsync-heavy writer added on the Postgres data filesystem (load avg up to 8.6): teardown 176–644 ms, DROP 165–626 ms — I/O contention is what moves it, as expected for a forced checkpoint. 0 backends still attached and 0 `(unnamed)` failures in all 14 runs. The spec itself is unchanged. | fixed |
