# Slice A oneshot poll CLI (CTP-488)

Offline-capable ops CLI wrapping `createPollBronRuntime` +
`runBronIngestPipeline(..., "poll")` for Coolify / on-box container ops.

**Not the scheduler.** Routine ingest is the on-box poller
([onbox-poller.md](./onbox-poller.md)), which replaced the Trigger schedule
`schedule-slice-a-polls` and its `poll-bron` task; this CLI is the manual
one-shot beside it. Motian backfill paths are untouched.

## When to use

| Situation | Action |
|-----------|--------|
| Poller stopped, or one bron needs a poll now | List then oneshot poll activated Slice A brons from Coolify server container |
| Routine scheduled ingest | Use the on-box poller ([onbox-poller.md](./onbox-poller.md)), not this CLI |
| Fresh DB seed / test-import / activate | Use `poll-bron-smoke.ts` (this CLI never seeds) |
| Motian Neon backfill | Out of scope — leave Motian alone |

## Safe defaults

- Default mode is **`--list` / `--dry-run`**: prints pollable targets, **no poll**.
- `--run` is required to execute.
- Targets are **activated + schedule-eligible Slice A** brons only (same
  `listPollableSliceABronnen` filter the on-box poller uses).
- Fan-out is **sequential** (bounded Coolify load). Optional `--limit N`.
- On non-hash hard failure, fan-out **stops** so ops can investigate.

## Invoke (repo / on-box)

```bash
# List what the poller would consider pollable
bun apps/worker/scripts/oneshot-slice-a-polls.ts --list

# Dry-run alias
bun apps/worker/scripts/oneshot-slice-a-polls.ts --dry-run --bron all

# One bron
bun apps/worker/scripts/oneshot-slice-a-polls.ts --run --bron tenderned

# Fan-out all pollable (cap optional)
bun apps/worker/scripts/oneshot-slice-a-polls.ts --run --bron all --limit 2
```

Requires `DATABASE_URL` (and production raw object store env as usual). With
`SEARCH_PROJECTOR=onbox`, outbox drain is deferred to the projector — same as
worker cloud mode.

## Coolify container (mirror enrich dryRun path)

Same pattern as container `enrich-incomplete` dryRun against prod DB:

```bash
# Replace <server> with Coolify server container id (e.g. ibiaal0a…)-…
sudo docker exec -w /app <server> \
  bun apps/worker/scripts/oneshot-slice-a-polls.ts --list

sudo docker exec -w /app <server> \
  bun apps/worker/scripts/oneshot-slice-a-polls.ts --run --bron all --limit 1
```

Capture JSON: `scrapeRunId`, `metrics.new` / `nieuw`, `writtenRecords`, status.
Keep `/readyz` `lagEvents≈0`. Stop if a non-hash hard fail appears.

## Motian / overview / LLM

- Motian: **untouched** — do not run Motian backfill from this CLI.
- `/bronnen/overview` unshadow: separate lane.
- LLM: N/A (poll path only).

## Scheduled Coolify / cron (CTP-489)

For recurring weekday ticks without Trigger credits, use the flock wrapper:

See [slice-a-oneshot-poll-schedule.md](./slice-a-oneshot-poll-schedule.md).

```bash
bash apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh
```

## Related

- `docs/runbooks/slice-a-live-smoke.md` — smoke / activate
- `docs/runbooks/enrichment-schedule.md` — enrich Trigger schedule + ops flip
- [onbox-poller.md](./onbox-poller.md): the scheduler this CLI sits beside
