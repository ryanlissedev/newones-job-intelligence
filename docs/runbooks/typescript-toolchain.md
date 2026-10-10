# TypeScript toolchain: tsc 6 gate + tsgo 7 fast path

Two compilers coexist on purpose (CTP-616):

- **`typescript` 6.0.3** (catalog) — the classic `tsc`. Backs every existing
  `check-types` script, `tsc -b` for `apps/server` (composite), the gate, and
  Next.js build-time type checking / `next typegen`, which consume the
  classic `typescript` JS API that TypeScript 7 replaced with a new surface.
- **`@typescript/native-preview` 7.0.0-dev.20260707.2** — the native compiler,
  exposed as `tsgo`. Published 2026-07-07 (>7 days before adoption, same code
  line as `typescript@7.0.2` stable published 2026-07-08).

## Usage

```bash
bun run check-types        # turbo fan-out, classic tsc (gate contract, unchanged)
bun run check-types:tsgo   # native tsgo over every apps/*/packages/* tsconfig
```

`check-types:tsgo` is additive: it loops `tsgo --noEmit -p` over each
workspace `tsconfig.json`. No `tsconfig` files changed; composite projects
(`apps/server`, `packages/api|auth|db`) pass under `--noEmit -p` the same way
they do under `tsc --noEmit`.

## What stays on tsc 6 and why

- **`apps/server` `tsc -b`** — composite build-mode emit; `tsgo -b` not yet
  proven for this repo's `dist` contract. TODO: re-evaluate on a later preview.
- **Next.js typegen/build** — `next build`/`next typegen` load the classic
  `typescript` package API; `typescript@7` ships a different `dist/api` surface.
  Do not bump the catalog `typescript` pin without proving Next against it.
- **`check-types:*` script-side tsconfigs** (`tools/backfill`,
  `scripts/production`, `benchmarks`, `scripts/ci-metrics`,
  `e2e/live-jobs`, `scripts/effect-e2e`, `scripts/performance`,
  `scripts/mcp-edge`, `scripts/effect-baseline`) — still tsc; extending the
  tsgo loop to them is a follow-up, not part of this spike.
- **`bun test`** — Bun tests never type-check and are a separate gate.

## Compiler-API inventory (2026-09-20)

No in-repo consumer imports the `typescript` package API
(`from "typescript"` / `require("typescript")` / `ts.createProgram`): zero
matches under `apps/`, `packages/`, `tools/`, `scripts/`, `benchmarks/`,
`e2e/`. `scripts/effect-baseline/versions.ts` only parses `bun.lock` text.
The sole API consumer is Next.js itself inside `next build`/`next typegen`.
`tsc` invocations live in workspace `check-types` scripts, the root
`check-types:*` script-side tsconfigs above, and
`.github/workflows/search-audit-evidence.yml`.

## Measurements (trunk vs head, this machine)

`bun run check-types` measured with `turbo run check-types --concurrency=2
--force` (cache bypassed); builds with `turbo run build --concurrency=2
--force`; wall = `/usr/bin/time -l` real, RSS = maximum resident set size.

| Cohort | Command | Wall (s) | Peak RSS |
| ------ | ------- | -------- | -------- |
| trunk | check-types (tsc, forced) | 8.19 / 8.57 / 7.90 | 998 / 998 / 1001 MB |
| head | check-types (tsc, forced) | 14.25 / 7.66 / 7.66 | 1351 / 1001 / 1000 MB |
| head | check-types:tsgo (new) | 2.71 / 2.59 / 2.57 | 875 / 890 / 883 MB |
| trunk | build (forced) | 20.77 / 13.12 / 12.93 | 1610 / 1003 / 1122 MB |
| head | build (forced) | 13.78 / 12.93 / 13.06 | 1083 / 1048 / 1081 MB |

The first head check-types run includes freshly generated `.next/types` input
for `web`; warm runs match trunk. tsgo covers all 13 workspace tsconfigs in
~2.6 s (~3× faster than the tsc fan-out) at slightly lower peak RSS.

## Rollback

Revert `package.json` + `bun.lock` (drop `@typescript/native-preview` and the
`check-types:tsgo` script) and the `compatibilityNotes` line in
`scripts/effect-baseline/versions.ts`. No runtime data migration; nothing
ships tsgo output.
