# EffectTS production enablement (controlled, per surface)

Linear: [CTP-479](https://linear.app/rcjt-studio/issue/CTP-479/effectts-production-enablement-controlled-per-surface) —
migration-map **Slice 14**. ADR framing: [ADR-0013](../adr/ADR-0013-effectts-platform-baseline.md),
[ADR-0014](../adr/ADR-0014-effectts-project-wide-adoption.md) (§4 rollout / rollback).

**Not a blanket flip.** Finishing CTP-453 children does **not** auto-enable Effect in
production. Catapulze enables **one surface at a time**, collects evidence, and can
roll back by unsetting the flag.

## Flags (default OFF)

Exact env value `"1"` enables. Anything else (unset, `0`, `true`, …) stays on the
prior/native path.

| Surface | Env key | What flips ON | Native path when OFF |
| --- | --- | --- | --- |
| db | `JI_EFFECT_DB` | Slice-8 store wrappers via `applyDbStoreEffectCanary` | Native `Postgres*Store` / readers |
| server | `JI_EFFECT_SERVER` | REST/MCP invokers → Effect transport boundary | Native Promise invokers |
| worker | `JI_EFFECT_WORKER` | `drain-outbox` task body → Effect boundary | Native `runDrainOutbox` |

The `poll-bron` half of this row is gone: polling moved to the on-box poller
([onbox-poller.md](./onbox-poller.md)), which has no Effect boundary.
| perf | `PERF_EFFECT_SPANS` (alias `JI_EFFECT_PERF`) | `@ji/performance/effect` spans | Native critical-path sessions only |

Search has no row: since CTP-627 `ManticoreSearchEngine.fromUrl` always uses
`FetchManticoreEffectClient`, there is no flag and no native fallback. The
runtime receipt is the stderr line `createProductionSliceADeps` writes once at
composition: `{"event":"slice_a_composition","savedSearches":"effect","search":"effect"}`.

Shared SoT: `@ji/env/effect-flags` (`isEffectSurfaceEnabled`, `readEffectSurfaceFlags`).

Server schema also accepts `JI_EFFECT_DB|SERVER` and `PERF_EFFECT_SPANS` as
optional `0|1` (default `0`) via `@ji/env/server`.

## Canary order (recommended)

Enable **one** Coolify env at a time; redeploy; evidence; only then consider the next.

1. `PERF_EFFECT_SPANS=1` — observability only (lowest blast radius)
2. `JI_EFFECT_DB=1` — store Promise boundaries on Slice-8 surfaces
3. `JI_EFFECT_SERVER=1` — REST/MCP transport boundary
4. `JI_EFFECT_WORKER=1` — Trigger task-body boundary (keep Trigger `maxAttempts`)

Do **not** flip multiple surfaces in one deploy during the first canary window.

## Evidence checklist (Catapulze)

After each flip + Coolify tip MATCH:

1. `GET /readyz` → 200 (components healthy)
2. `GET /version` → 200 with expected `releaseSha` (40-char tip)
3. Authenticated `GET /jobs` Boolean search still returns rows
4. `/bronnen` is **not** access-denied (authenticated list works)
5. No new 5xx spike on the flipped surface; projector lag unchanged if worker/search touched

Record paths/screenshots under operator evidence (no secrets, no Motian PII).

## Rollback drill (required once per surface before calling Slice 14 Done)

1. Set the surface flag back to unset/`0` in Coolify; redeploy (or restart with env cleared).
2. Confirm `/readyz` + `/version` still healthy.
3. Confirm `/jobs` Boolean rows + `/bronnen` still work on the **native** path.
4. Note wall-clock time to restore (target: within RTO; no data migration for these flags).

Rollback = **flag off → prior/native path**. No schema migrate, no Motian bounce.

## Out of scope for this runbook

- Motian rematch / backfill / vault (CTP-371)
- Demo re-record
- Blanket `JI_EFFECT_*=1` for all surfaces in one change
