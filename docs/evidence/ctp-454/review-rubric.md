# CTP-454 review rubric — retry / cancel / cleanup owners

Filled for the **native** Promise adapters on peildatum main after the live fixture measurement. The **Effect** variant is blocked on CTP-455 (first-party `effect@rc`).

## Native variant (current baseline)

| Question | Identifiable? | Owner / path |
| --- | --- | --- |
| Retry owner (request) | yes | `packages/connectors` `withRetry` / `apps/worker/src/poll-bron-run.ts` retryPolicy — `maxAttempts: 3`, `initialDelayMs: 250`, `maxDelayMs: 5000`, multiplier 2 + full jitter |
| Retry owner (Trigger task) | yes | `apps/worker/src/tasks/poll-bron.ts` `schemaTask.retry` — `maxAttempts: 2` |
| Combined ceiling | yes | Product of request × task attempts; must not silently increase (ADR-0013) |
| Blind write retries | no (forbidden) | Spott writes use export-effect reservation/idempotency; out of read-baseline scope |
| Cancellation path | partial | `AbortSignal` **not** plumbed into `JsonLdClient` / `SpottClient` fetch today. Harness records AbortController race-stop only. CTP-455 must honor deadline/signal on Effect adapters. |
| Cleanup owner | yes | Fixture mode: no adapter-owned timers; harness `clearTimeout` + fixture file I/O. Live path: caller owns `fetch` abort plumbing once wired. |

## Effect variant

| Question | Identifiable? | Notes |
| --- | --- | --- |
| Retry / cancel / cleanup | **blocked** | No first-party Effect runtime in repo yet (`effectDirect: null`). Track under CTP-455. |

## Wire-contract checklist pointer

See [docs/effectts/json-ld-spott-wire-contract.md](../../effectts/json-ld-spott-wire-contract.md). Outcomes for this measurement are also embedded in each `native-*.json` artifact under `reviewRubric`.
