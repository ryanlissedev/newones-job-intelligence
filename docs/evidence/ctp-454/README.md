# CTP-454 evidence — EffectTS platform baseline

Norm: [ADR-0013](../../adr/ADR-0013-effectts-platform-baseline.md) · Wire-contract: [JSON-LD/Spott](../../effectts/json-ld-spott-wire-contract.md) · Schema: `scripts/effect-baseline/`

## Index

| Artifact | Kind | Notes |
| --- | --- | --- |
| [native-cold-*.json](./) | measured | Native TS fixture cohort, cold (fresh clients each pass) |
| [native-warm-*.json](./) | measured | Native TS fixture cohort, warm (reused clients + warmup) |
| [review-rubric.md](./review-rubric.md) | review | Retry / cancel / cleanup owners per variant |
| [commands.md](./commands.md) | runbook | Exact host commands used for this evidence |

Volatile copies also land under `.artifacts/effect-baseline/` (gitignored).

## What was measured (native path)

- Adapters: JSON-LD hero `fetchListing` + `fetchDetail`; Spott `listVacancies` + `getVacancy`
- Mode: fixtures/sandbox only (`liveEnabled: false`); production activation OFF; no PII
- Host: `catapulze` (exe.dev), Linux x86_64, 2 vCPU, ~7.7 GiB
- Toolchain: Bun packageManager `1.3.14`, host Bun `1.4.0`, TypeScript `6.0.3`, transitive `effect@3.21.0` only
- Metrics: latency p50/p95, attempt counts, cancellation latency, resource release, peak RSS, build + typecheck duration, server bundle bytes, direct dependency count, adapter LOC (observe), review rubric

## Effect Slice 1 (CTP-455)

See [ctp-455-effect-slice1.md](./ctp-455-effect-slice1.md) for shared runtime + Effect adapter notes (production OFF).

## Still blocked (Effect comparison)

First-party `effect@rc` pin / runtime migration is **CTP-455+ / CTP-453**. Dual-path Effect vs native comparison is not claimed here. Gaps for Effect follow-up:

1. No direct `effect` dependency to exercise
2. Native `JsonLdClient` / `SpottClient` do not yet accept `AbortSignal` (harness measures race-stop only)
3. Effect variant review rubric remains N/A until adapters land

## Reproduce

```bash
bun run effect-baseline:dry-run -- --run-kind cold
bun run effect-baseline:measure -- --run-kind cold --iterations 12 --evidence-dir docs/evidence/ctp-454
bun run effect-baseline:measure -- --run-kind warm --iterations 12 --warmup 3 --evidence-dir docs/evidence/ctp-454
bun test --max-concurrency 2 scripts/effect-baseline/
```
