# CTP-455 Slice 1 — Effect shared runtime (JSON-LD + Spott reads)

- Status: implementation landed; production activation **OFF**
- Parent: CTP-453 (not Done)
- Baseline: [ADR-0013](../../adr/ADR-0013-effectts-platform-baseline.md), [ADR-0014](../../adr/ADR-0014-effectts-project-wide-adoption.md), native evidence in this folder

## Package boundaries

| Module | Role |
| --- | --- |
| `@ji/connectors/effect-runtime` | Shared execution core (faults, retry, HTTP, `runReadIoPromise`) — **no JI domain types** |
| `packages/connectors/src/json-ld/client-effect.ts` | Effect JSON-LD listing/detail; Promise SDK via `createJsonLdEffectClient` |
| `@ji/application/export/spott/effect` (`client-effect.ts`) | Effect Spott list/get only; write/POST remains native; not re-exported via export barrel |

Native factories (`createJsonLdClient`, `createSpottClient`) stay the default export path. Effect clients are opt-in.

## Measurement notes vs native CTP-454

| Topic | Observation |
| --- | --- |
| Correctness | Fixture listing/detail + list/get parity covered by Effect adapter specs |
| Retry ceiling | Shared core keeps `maxAttempts: 3` (ADR-0013); no Trigger task budget change |
| Cancel | AbortSignal plumbed through Effect `tryPromise` + `runPromise` options; native path still harness-race only |
| Wins | Typed faults, Retry-After-aware schedule, scoped finalizers, one core for both adapters |
| Regressions / uncertainty | Full dual-path latency p50/p95 vs `native-*-*.json` not claimed as enforce budget yet (observe); Effect RC API surface may shift before GA |
| Adapter LOC | Observe via `scripts/effect-baseline` adapterLoc + new Effect files; LOC reduction is not a success criterion |

## Commands

```bash
bun test --max-concurrency 2 \
  packages/connectors/src/effect-runtime/effect-runtime.spec.ts \
  packages/connectors/src/json-ld/json-ld-effect.spec.ts \
  packages/application/src/export/spott/spott-effect.spec.ts \
  packages/connectors/src/json-ld/json-ld.spec.ts \
  packages/application/src/export/spott/spott.spec.ts \
  scripts/effect-baseline/
```
