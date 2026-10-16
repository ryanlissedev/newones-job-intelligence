<!-- Moved verbatim from AGENTS.md on 2026-10-17 (AGENTS.md is now a map). -->

# Workspace facts and preferences

## Learned User Preferences

- Do not commit accidental `docs/` formatter churn from pre-commit; restore or leave unstaged when committing code-only changes.
- Commit OpenWiki updates separately from feature work (pre-commit wiki guard).

## Learned Workspace Facts

- Quality verbs: `bun run fix` / `check` (changed vs `origin/main`), `gate` (full pre-push), `wiki` (OpenWiki local). `fix:all` / `check:all` are deliberate whole-tree escape hatches.
- Lefthook owns pre-commit (scoped `ultracite fix {staged_files}`) and pre-push (`gate`). Never run `qlty githooks install`.
- Qlty (`.qlty/qlty.toml`) covers shell/workflows/secrets; Ultracite + anti-slop owns TS/JS. All `qlty check` uses `--no-formatters`; never `qlty fmt`.
- Agents must run `bun run check` (qlty on changed files vs `origin/main`, `--no-formatters`) before finishing when they touched YAML/shell/workflows; still `bun run fix` for TS/JS; never `qlty fmt`; never skip Lefthook with `--no-verify` to dodge yamllint.
- Visual proof: for PRs that change `apps/web` or other user-visible UI, live-verify via `.cursor/skills/verify-job-intelligence/` is the default (web :3001, API :3000). Use an isolated browser session; never the operator's already-running session unless `JI_VERIFY_ALLOW_SHARED=1`. Set up like a user, then capture proof (short screen recording by default; see [Visual evidence](visual-evidence-and-pr.md#visual-evidence)). No tRPC-only shortcut as dashboard proof.
- Captures are proof only after the agent has opened them and confirmed the asserted state is actually in frame; re-shoot if not. An uninspected capture must not be attached. File-exists, non-zero duration, and test exit 0 all pass on a blank window.
- Captures run against seeded/fixture data only. Never screenshot Motian production, real vacancy/aanvraag payloads, credentials, or PII. Sanitize before attaching.
- Attach proof to the PR (and linked Linear issue when one exists). Never commit screenshots/videos/artifacts into git (including `.cursor/skills/verify-job-intelligence/artifacts/`). If visual proof is infeasible, state the exact blocker in the PR body — never skip silently.
- Playwright/e2e waits on asserted UI states, not sleeps.
- Visual proof is not required for Postgres/CI/workflow-only PRs.
- Clawpatch protocol: one CI finding → one patch → `bun run gate` → then push. Do not pile unrelated formatter, backup, compose, and YAML fixes in the same commit. `fix` never self-commits.
- Local Postgres has no host `psql`/`pg_dump`; the dev DB runs in the `catapulze-job-intelligence-postgres-1` container publishing `127.0.0.1:5432`. Other projects' Postgres containers exist on other ports (e.g. 55432) — match the published host port exactly and probe that the container authenticates the expected role before using its `pg_dump`/`psql`. Killed test runs leave `ji_test_iso_*` databases behind; drop them via `pg_database` after confirming the embedded PID is dead.
