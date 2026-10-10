---
name: ji-source-wave
description: "Run a wave of Catapulze Job Intelligence source work end to end: Linear census, live route probes, parallel lane agents in git worktrees, serial pre-push gates, PRs, exe.dev clean-room validation, and Linear + bronnenoverzicht updates. Use when asked to pick up the next wave of source issues, implement missing/failing bronnen, or work the CTP-505 backlog in parallel."
---

# Source wave workflow

Repeatable wave loop proven across waves 4–6 (PRs #382–#390). A wave is: census → lane assignment → parallel build → review → serial push → PR → clean-room → Linear/doc bookkeeping → cleanup.

## 1. Census before building

- List open Linear issues under the parent (e.g. CTP-505) and read the bronnenoverzicht document. Many issues are already Done — check registry membership in `packages/application/src/sources/` before assuming a source is missing.
- Probe every candidate route live _now_, not from an old investigation: list page, detail page, `robots.txt`, sitemap. A source is implementable only when a real unauthenticated route returns real data today.
- Classify each item: **build** (route verified), **blocked** (login/SSO/account — comment and leave Backlog; no code can fix access), **drop** (WAF challenges even robots.txt, or the source duplicates data already ingested — cancel with evidence).
- POC boundary: ToS does not block, but supplied credentials are still the only credentials; no CAPTCHA solving, stealth fingerprinting, or proxy rotation.

## 2. Lane assignment

One implementable item per lane. Each lane gets its own:

- git worktree under `/private/tmp/` (e.g. `git worktree add /private/tmp/w<N>-<slug> -b ryan1/<issue>-<slug>`)
- **explicit bronId assigned up front** — never let lanes pick; collisions cross-contaminate the known-hash store (`sources.spec.ts` asserts uniqueness)
- subagent with the verified route, the probe evidence, the connector contract, and the verification list (`bun x ultracite fix`, `bun test`, `bun run check-types`, `bun run check-secrets` — `bun test` alone is not enough)

Run resolve-only items (cancellations, blocked comments) on the main thread while lanes build.

## 3. Connector requirements for every lane

Implementation + source definition + registry entry + normalizer + **real recorded fixtures** (mtime-based `capturedAt`, mechanical trimming only) + specs + `liveEnv` flag + docs + honest live-blocker notes + DEC-008 whitelist projection. Fail-closed on block pages; absent data stays absent — never synthesize fields the source does not publish.

## 4. Review lane diffs yourself

Agent reports are not review. Check the diff for: DEC-008 projection, fail-closed error paths, real fixture provenance, correct bronId, registry conventions (`listingHashCoversDetail`, `liveEnv`, crawl delay), and that "missing at source" is documented, not worked around. A fix after review voids the review — re-check.

## 5. Push serially

Parallel `git push` runs collide: the pre-push gate's migration-upgrade tests share one fixed `MIGRATION_UPGRADE_TEST_DB` name, and concurrent gates fail on it. Push lanes one at a time. If a push fails with multiple migration-test failures while another gate is running, wait and re-run — no code change needed.

PR bodies go through `--body-file`; apostrophes in inline `--body` strings break quoting. Body covers: problem, why, user impact, evidence with commands + exit codes, known gaps, `## Partial` when Linear ACs remain open.

**Any lane that touches `apps/web` or other user-visible UI requires visual proof, always** — not optional, not "the check passed". Live-verify via `.cursor/skills/verify-job-intelligence/` (web :3001, API :3000) in an isolated browser session with seeded/fixture data. Default is a short H.264 MP4 recording of the asserted UI state; a screenshot only for static changes. Open and inspect the capture before attaching — an uninspected file must not be attached. Attach to the PR (and Linear issue when linked), never commit artifacts to git. If visual proof is infeasible, the PR body states the exact blocker; never skip silently. Put this requirement in the lane agent's verification list when its scope includes UI.

## 6. Clean-room validation on exe.dev

The local `exe.dev` CLI may be absent — SSH-based control works:

```sh
ssh exe.dev whoami --json          # confirm region == "fra"
ssh exe.dev new --name=<slug> --image=<image from .crabbox.yaml> --cpu=2 --memory=8GB --disk=40GB --no-email --json
ssh <slug>.exe.xyz 'curl -fsSL https://bun.sh/install | bash && curl -fsSL https://qlty.sh | bash'
```

Clone with `https://x-access-token:$(gh auth token)@github.com/...`. Before `bun run gate`:

- `docker volume create catapulze-postgres-p0`
- `cp .env.example .env` and set `BETTER_AUTH_SECRET` to a dev-only placeholder
- `docker compose up -d postgres manticore manticore29 raw-storage-minio redis` and wait for `pg_isready`

Run the gate **serially** per PR. A single advisory-lock (`reassert()`) timeout under parallel load on 2 CPUs is a known flake — re-run the file in isolation; it passes in ~80ms.

After validation: `ssh exe.dev rm <slug>` and confirm via `ssh exe.dev ls`. An unstopped lease is a bug.

## 7. Linear and document bookkeeping

- `save_comment` takes `issueId`, not `issue`. Each comment: PR link, what changed, evidence (test counts, exit codes), which ACs close, which stay open.
- Status stays In Progress while any AC is open. Never mark Done on partial delivery.
- Update the bronnenoverzicht document via patch edits only when the wave changes a source row — tooling/coverage work does not touch it.

## 8. Cleanup

Remove a worktree only when `git status` is clean **and** `git log origin/<branch>..<branch>` is empty — commits live on origin, dirty worktrees keep real work. Stop and delete leases in the same session that created them.

## Failure modes already paid for

- Parallel gates → shared `MIGRATION_UPGRADE_TEST_DB` collision → serial pushes.
- `gh pr create --body "...don't..."` → broken quoting → always `--body-file`.
- Linear `save_comment` with `issue:` → rejected → use `issueId`.
- Missing local `exe.dev` binary → use SSH control (`whoami`, `new`, `ls`, `rm`).
- Worktree commits can skip hooks → re-run gates by hand; the pre-push gate is the verification.
