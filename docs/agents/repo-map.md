<!-- Moved verbatim from AGENTS.md on 2026-10-17 (AGENTS.md is now a map). -->

# Repo map and layering

Bun monorepo for **Newones** (job intelligence product for thenewones.nl). Workspace packages use the `@ji` scope (Job Intelligence). Runtime identifiers such as the Compose project / root package / MCP server name `catapulze-job-intelligence` stay until a later server-access rename.

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
