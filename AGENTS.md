# Catapulze Job Intelligence

Bun monorepo for Catapulze Job Intelligence. Workspace packages use the `@ji` scope (Job Intelligence).

| Path                   | Role                                      |
| ---------------------- | ----------------------------------------- |
| `apps/web`             | Next.js UI on port 3001                   |
| `apps/server`          | Hono + tRPC API on port 3000              |
| `packages/api`         | tRPC router and procedures                |
| `packages/application` | Use-case layer (bronregister, Slice A)    |
| `packages/auth`        | Better Auth                               |
| `packages/connectors`  | Connector contract and source adapters    |
| `packages/db`          | Drizzle schema and postgres-js client     |
| `packages/domain`      | Domain types and Boolean parser (Slice A) |
| `packages/env`         | Typed env for server and web              |
| `packages/ui`          | Shared UI components                      |
| `packages/config`      | Shared TypeScript config                  |

Do not query Postgres from the web app. Reads and writes go through `apps/server` / `packages/api`. Secrets stay in `apps/server/.env` and `apps/web/.env` (see `.env.example` files); never commit them.

The parent directory name `clients:catapulze` contains a colon, which splits Unix `PATH` when an absolute `node_modules/.bin` path is prepended. Package scripts prepend the **relative** `./node_modules/.bin` entry so binaries resolve. Do not switch those scripts back to bare `tsc` / `turbo` / `ultracite` without that prefix.

Linting uses Ultracite (Oxlint + Oxfmt) plus a vendored [anti-slop](https://github.com/dmmulroy/anti-slop) plugin at `tools/oxlint/anti-slop/`. Treat that copy as owned project tooling: change the rules here rather than depending on a published package. Effect-specific anti-slop rules (`anti-slop-effect`) are enabled only in packages/apps with a direct `effect` dependency — see `oxlint.config.ts` overrides (CTP-477 / migration-map Slice 13).

Do not import `@ji/db`, `drizzle-orm`, or `packages/infra` from `apps/web`. Run `bun run check-layering` after changing web imports. Run `bun test` (max 2 workers, no watch) and `bun run check-secrets` before finishing a change. Secrets stay out of git; `.env.example` lists names and placeholders only.

Slice A plans and docs may reference `packages/infra`; this repo uses `@ji/db` for Postgres/Drizzle instead.

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

### Production release lane

The architecture and the failure mode that cost a full session to rediscover (2026-09-18).

- `Deploy production` (`.github/workflows/deploy-production.yml`) triggers on every green CI on main and is **fail-closed**: `scripts/production/release-gate.ts` must pass before any Coolify credential exists.
- **The release ledger lives in GitHub Deployments.** A record counts only when its `payload` parses with a 40-char `candidate_sha` matching `deployment.sha` plus a non-empty `workflow` or `source` (`isReleaseLedgerEntry`). Jobs that declare `environment: production` also get an auto-created deployment with empty payload — those are NOT ledger entries.
- **The recurring red state.** The gate requires the newest ledger entry's latest status to be `success`. GitHub auto-inactivates older deployments when a new one is created in the same environment, so a manual release written in a payload format the predicate does not recognize leaves the newest _recognized_ entry `inactive` — the gate blocks before the lease step and every later run fails the same way. Fix per the runbook "Seeding the baseline": create a deployment whose `ref` is the actually-running SHA with payload `{workflow:"Deploy production", workflow_run_id:"manual", run_attempt:"1", job:"seed", candidate_sha:<sha>}`, post `success`, and point `PRODUCTION_LAST_DEPLOYED_RELEASE_JSON`'s `releaseId` at it.
- **Manual-lane paths never autodeploy.** `blockedReleasePath` marks `packages/connectors/`, `apps/worker/`, `packages/db/src/migrations|schema`, `packages/env`, `packages/search/src/schema`, backfill/migration scripts, and `apps/server/src/{index,readiness,release}.ts`. A release touching them needs the operator path, and Deploy production _stays red by design_ until an operator ships it. That red is the gate working, not a bug.
- **Operator access.** Production is on-box Postgres on Hetzner (SSH alias and operator user live in the private ops notes; Coolify runs on the box's internal port). Neon is read-only import source only (ADR-0011) — never run prod migrations against Neon. Runbook order: `docs/runbooks/hetzner-deploy.md` → `automatic-production-deploy.md` → `neon-migration-catchup.md` (migration gate).
- Local env note: after pulling main, stale `.next` route types and missing new deps break `check-types`; run `bun install` and `bun x next typegen` in `apps/web` before assuming a code error.

---

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `bun x ultracite fix` before committing to ensure compliance.

## Learned User Preferences

- Do not commit accidental `docs/` formatter churn from pre-commit; restore or leave unstaged when committing code-only changes.
- Commit OpenWiki updates separately from feature work (pre-commit wiki guard).

## Learned Workspace Facts

- Quality verbs: `bun run fix` / `check` (changed vs `origin/main`), `gate` (full pre-push), `wiki` (OpenWiki local). `fix:all` / `check:all` are deliberate whole-tree escape hatches.
- Lefthook owns pre-commit (scoped `ultracite fix {staged_files}`) and pre-push (`gate`). Never run `qlty githooks install`.
- Qlty (`.qlty/qlty.toml`) covers shell/workflows/secrets; Ultracite + anti-slop owns TS/JS. All `qlty check` uses `--no-formatters`; never `qlty fmt`.
- Agents must run `bun run check` (qlty on changed files vs `origin/main`, `--no-formatters`) before finishing when they touched YAML/shell/workflows; still `bun run fix` for TS/JS; never `qlty fmt`; never skip Lefthook with `--no-verify` to dodge yamllint.
- Visual proof: for PRs that change `apps/web` or other user-visible UI, live-verify via `.cursor/skills/verify-job-intelligence/` is the default (web :3001, API :3000). Use an isolated browser session; never the operator's already-running session unless `JI_VERIFY_ALLOW_SHARED=1`. Set up like a user, then capture proof (short screen recording by default; see **Visual evidence** below). No tRPC-only shortcut as dashboard proof.
- Captures are proof only after the agent has opened them and confirmed the asserted state is actually in frame; re-shoot if not. An uninspected capture must not be attached. File-exists, non-zero duration, and test exit 0 all pass on a blank window.
- Captures run against seeded/fixture data only. Never screenshot Motian production, real vacancy/aanvraag payloads, credentials, or PII. Sanitize before attaching.
- Attach proof to the PR (and linked Linear issue when one exists). Never commit screenshots/videos/artifacts into git (including `.cursor/skills/verify-job-intelligence/artifacts/`). If visual proof is infeasible, state the exact blocker in the PR body — never skip silently.
- Playwright/e2e waits on asserted UI states, not sleeps.
- Visual proof is not required for Postgres/CI/workflow-only PRs.
- Clawpatch protocol: one CI finding → one patch → `bun run gate` → then push. Do not pile unrelated formatter, backup, compose, and YAML fixes in the same commit. `fix` never self-commits.
- Local Postgres has no host `psql`/`pg_dump`; the dev DB runs in the `catapulze-job-intelligence-postgres-1` container publishing `127.0.0.1:5432`. Other projects' Postgres containers exist on other ports (e.g. 55432) — match the published host port exactly and probe that the container authenticates the expected role before using its `pg_dump`/`psql`. Killed test runs leave `ji_test_iso_*` databases behind; drop them via `pg_database` after confirming the embedded PID is dead.

### Visual evidence

A **short screen recording is the default**; a screenshot suffices only when the change is static (renamed label, new field present). Record the actual interaction on a running app using the verify skill and seeded/fixture data so reviewers see what CI would verify.

**Recorder:** Playwright `recordVideo` / `video: 'on'` against the live-verify instance — one test or clip per claim. Scripts wait on asserted UI states, never sleeps.

**Format:** Encode as H.264 in an MP4 container, not Playwright's default VP8-in-WebM. GitHub, Linear, and phones preview MP4; WebM often does not.

```bash
ffmpeg -i clip.webm \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart \
  clip.mp4
```

**Embed in the PR:** Check the installed CLI and the actual attachment flag before posting:

```bash
gh --version
gh pr comment --help | rg -- '--attach|--body-file'
gh pr comment --body-file proof.md --attach proof.mp4
```

`proof.md` is an example body file containing the exact claim and code path; `proof.mp4` is an example artifact path. `gh pr comment` resolves the pull request from the current branch. GitHub CLI v2.99.0+ supports repeatable `--attach` for issue/PR create, edit, and comment commands. Use `--attach 'screenshot.png#Alt text'` for image alt text; video attachments have no alt-text suffix. The command uses the OAuth token from `gh auth login` or a classic PAT and requires repository write access; GitHub Enterprise Server is not supported. If the version or help check fails, upgrade `gh` through the approved package-management path or use GitHub's browser upload flow. Do not use undocumented CLI subcommands or hand-written upload requests. See [GitHub CLI: Media in issues, pull requests, and comments](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) for the supported behavior and limits. Reference the proof in the linked Linear issue when one exists, then read the posted PR or comment back and confirm the attachment renders in the intended context; command success alone is not proof.

Label each clip with the exact claim it proves and which code path. Use **Before / After** pairs for fixes.

**Refactors are not exempt.** A refactor claimed inert arguably needs footage more than a feature: tests can stay green while visible behavior moves. Never label passing test output as "Screenshots" or "Evidence" of user-visible behavior.

### PR bodies and definition of done

PR bodies should carry: **problem**, **why** (including what was ruled out), **user impact** ("nothing" is valid when justified), **evidence** (commands with real exit codes plus visual proof when UI changes), and **known gaps**.

Never judge a gate through a pipe: `cmd | tail` reports `tail`'s exit status, not `cmd`'s.

If a PR closes only part of a Linear ticket, add a `## Partial` section listing acceptance criteria closed vs remaining. Do not let GitHub–Linear automation mark the whole issue Done.

**Done** means every acceptance criterion is met, not that the PR merged. After merge, Linear status must match remaining ACs.

### Playwright assertions (e2e)

Where Playwright drives UI proof, scope assertions to visible elements (`:visible`, roles, labels). Do not treat hidden SSR duplicates as data. Run `bun run fix` on e2e specs you touch (Lefthook/Ultracite).

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

<!-- TRIGGER.DEV SKILLS START -->

## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.agents/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`, `trigger-authoring-tasks`, `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
