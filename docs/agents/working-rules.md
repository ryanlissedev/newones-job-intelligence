<!-- Moved verbatim from AGENTS.md on 2026-10-17 (AGENTS.md is now a map). -->

## Working rules learned in practice

Each of these cost a real failure. They are cheap to follow and expensive to rediscover.

**`bun test` does not type-check.** A change can be 300/300 green and still fail `check-types` in the pre-push gate. Run `bun run gate` — or at minimum `bun run check-types` — before calling a change done, and name it explicitly in any delegated task's verification list.

**A commit in a linked worktree may run without hooks.** `bun install` there fails on its `lefthook install --reset-hooks-path` step (it tries to rewrite the outer repo's `.git/hooks` and is refused), so until it is installed, `git commit` silently skips pre-commit. After any worktree commit, re-run the gates by hand. Never use `--no-verify`.

**Rebase before reading a diffstat.** A branch on a stale base reports everything merged since as deletions.

### Adding a source

`docs/sources/README.md` has the mechanics. Three rules that are not obvious from it:

- **bronId is assigned up front, never "next free".** It keys the known-hash store, observations and seed rows, so two sources sharing one cross-contaminate as soon as either goes live. `packages/application/src/sources/sources.spec.ts` asserts uniqueness across `SOURCES`; when several sources are built in parallel, hand each branch its id explicitly rather than letting each pick.
- **Fixtures are real recordings.** Capture with a real request, keep the raw response, and set `capturedAt` from that file's actual mtime in UTC — never a rounded placeholder. Trim by _mechanical_ stripping (scripts, styles, svg, nav, footer, contact blocks); never retype or invent markup, values or field names. Remove PII rather than replacing it with plausible fake names — a fake recruiter name in a fixture reads as real data to the next person.
- **The recipe doc can be wrong; live capture wins.** One source's doc promised a single call returning every record, while the endpoint actually paginated. Follow what the endpoint does, and correct the doc.

Absent data stays absent: when a source genuinely does not publish a tarief, start date or deadline, the field is UNKNOWN with honest provenance. Do not infer it from a neighbouring field, and record in a docblock that it is missing at the source, so a later reader does not mistake it for a parsing bug.

**DEC-008 minimisation:** connectors whitelist on the way out — build a fresh object naming each field, as `projectOpdrachtoverheidTender()` in `packages/connectors/src/opdrachtoverheid/connector.ts` does. Unlisted upstream fields must not reach the payload or the stored body.

### Review

Autoreview and the end-of-deliverable review catch different classes of problem: a bronId collision once passed two independent autoreviews at 0.98 and was caught only by the final review reading against the stated goal. Run both, and treat any fix made after a review as voiding it — get a fresh one.
