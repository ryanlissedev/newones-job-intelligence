# CTP-489 — Scheduled Coolify / cron oneshot Slice A polls

Date: 2026-09-08  
Linear: [CTP-489](https://linear.app/rcjt-studio/issue/CTP-489)  
Base: `27b86c71` (#220 CTP-488)

## Landed

- `apps/worker/scripts/scheduled-oneshot-slice-a-polls.sh` — flock wrapper around
  `oneshot-slice-a-polls.ts --run --bron all` (skip on lock_held, exit 0)
- Harden oneshot CLI: soft/hash continue, hard-fail stop + non-zero exit,
  JSON summary via `summarizeOneshotRun` (`totals` / `hardFail` / timestamps)
- Runbook `docs/runbooks/slice-a-oneshot-poll-schedule.md` + link from
  `slice-a-oneshot-poll.md`
- Motian untouched; `/bronnen/overview` unshadow not in scope; no Trigger spend

## Verify

```bash
bun test apps/worker/src/oneshot-slice-a-polls.spec.ts \
  apps/worker/src/effect/effect.spec.ts
bun run gate
```
