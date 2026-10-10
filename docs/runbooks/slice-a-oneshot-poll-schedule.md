# Scheduled Coolify / cron oneshot Slice A polls (CTP-489)

Fallback durability: run the CTP-488 oneshot CLI on a weekday cadence from
Coolify Scheduled Tasks (or host cron).

**Not the scheduler.** Routine ingest is the on-box poller
([onbox-poller.md](./onbox-poller.md)), which replaced the Trigger schedule
`schedule-slice-a-polls` and its `poll-bron` task; keep this Coolify schedule
disabled while the poller is healthy. Motian backfill paths are untouched. LLM OFF.

## When to use vs the poller

| Situation | Action |
|-----------|--------|
| Poller stopped or stuck and cannot be restored quickly | Enable this Coolify/cron schedule |
| Poller healthy | Use the poller; disable this Coolify schedule |
| One-off prove / single bron | Use `oneshot-slice-a-polls.ts` directly (see [slice-a-oneshot-poll.md](./slice-a-oneshot-poll.md)) |
| Motian Neon backfill | Out of scope — leave Motian alone |

## Wrapper (flock + JSON + hard-fail exit)

`apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh`:

- Acquires a non-blocking `flock` on `ONESHOT_SLICE_A_LOCK_FILE` (default
  `/tmp/oneshot-slice-a-polls.lock`) so overlapping ticks **skip** instead of
  double-polling (`{"status":"skipped","reason":"lock_held"}`, exit 0).
- Runs `bun …/oneshot-slice-a-polls.ts --run --bron all` (extra args forwarded).
- Emits start/finish JSON; the CLI prints a final summary with
  `succeeded` / `failed` / `softFailed` / `hardFail` / `totals`.
- Soft/hash failures continue fan-out; **hard-fail stops** and exits non-zero.

Env overrides:

| Var | Default | Purpose |
|-----|---------|---------|
| `ONESHOT_REPO_ROOT` | `/app` | Repo root inside Coolify server container |
| `ONESHOT_SLICE_A_LOCK_FILE` | `/tmp/oneshot-slice-a-polls.lock` | flock path |

## Coolify Scheduled Task

Suggested cadence while Trigger is blocked: **every 30 minutes** on weekdays
(`Europe/Amsterdam`), staggered away from Motian work:

```cron
*/30 * * * 1-5
```

Command (server application container, working directory `/app`):

```bash
bash apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh
```

Host-side equivalent:

```bash
sudo docker exec -w /app <server-ibiaal0a…> \
  bash apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh
```

Optional cap for a first prove tick:

```bash
bash apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh --limit 1
```

## Ops checklist

1. Tip MATCH on Coolify server (oneshot scripts present in image).
2. `/readyz` ready + `lagEvents≈0` before enabling the schedule.
3. Capture one tick JSON: `scrapeRunId`, `totals.nieuw`, `hardFail`, exit code.
4. Keep Motian untouched; do not flip LLM residual.
5. Once the poller is healthy again: confirm one `poller_source` line per
   expected bron, then **disable** this Coolify schedule.

## Related

- [slice-a-oneshot-poll.md](./slice-a-oneshot-poll.md) — manual CLI
- [enrichment-schedule.md](./enrichment-schedule.md) — Trigger enrich schedule
- [onbox-poller.md](./onbox-poller.md): the on-box poller that replaced the
  `schedule-slice-a-polls` cloud fan-out. Scheduled polling now runs there and
  this Coolify schedule exists only as a manual fallback.
