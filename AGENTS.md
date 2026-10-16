# Newones (Job Intelligence) — agent map

Bun monorepo for **Newones** (`@ji/*`). This file is a map: read only the rows your task touches. Details live in the linked docs; nothing was removed.

| Topic | Read when | Where |
| --- | --- | --- |
| Repo layout, ports, PATH quirk, web↔DB layering | First task in this repo; touching `apps/web` imports or package scripts | [docs/agents/repo-map.md](docs/agents/repo-map.md) |
| Working rules learned in practice (type-check, worktree hooks, rebase) | Before calling any change done | [docs/agents/working-rules.md](docs/agents/working-rules.md) |
| Adding a source (bronId, real fixtures, DEC-008 minimisation) | Adding or changing a connector/source | [docs/agents/working-rules.md#adding-a-source](docs/agents/working-rules.md#adding-a-source), [docs/sources/README.md](docs/sources/README.md) |
| Review (autoreview + end-of-deliverable review) | Before handing off or merging | [docs/agents/working-rules.md#review](docs/agents/working-rules.md#review) |
| Production release lane, deploy gate, ledger | Anything touching deploy, release, prod DB or `deploy-production.yml` | [docs/agents/production-release.md](docs/agents/production-release.md) |
| Quality verbs, Lefthook, Qlty, local Postgres, user preferences | Running gates, committing, local DB work | [docs/agents/workspace-facts.md](docs/agents/workspace-facts.md) |
| Visual evidence, PR body, definition of done, Playwright assertions | Opening a PR or changing user-visible UI | [docs/agents/visual-evidence-and-pr.md](docs/agents/visual-evidence-and-pr.md), [.github/pull_request_template.md](.github/pull_request_template.md) |
| Code style (Ultracite) | Only when a lint error is unclear | [docs/agents/code-standards.md](docs/agents/code-standards.md) |

## Enforced by checks (not repeated here)

| Rule | Check |
| --- | --- |
| Formatting and code style | Ultracite/Oxlint + vendored anti-slop (`bun run fix`, `bun run check`; Lefthook pre-commit) |
| `apps/web` must not import `@ji/db`, `drizzle-orm`, `packages/infra` | `bun run check-layering` |
| No secrets in git | `bun run check-secrets` |
| Types must pass (`bun test` does not type-check) | `bun run check-types`, `bun run gate` (Lefthook pre-push) |

## Hard rules (always loaded)

- Never use `--no-verify`. A commit in a linked worktree can skip hooks: re-run the gates by hand.
- `bun test` (max 2 workers, no watch) is not a type-check: finish with `bun run gate` or at least `bun run check-types`.
- Never set or forge `RELEASE_APPROVAL` or the approval file; report a production-gate block to Ryan ([Production release lane](docs/agents/production-release.md)).
- Never run `qlty fmt` or `qlty githooks install`.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

<!-- TRIGGER.DEV SKILLS START -->

## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.agents/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`, `trigger-authoring-tasks`, `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
