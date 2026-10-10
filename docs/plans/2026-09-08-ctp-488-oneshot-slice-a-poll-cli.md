# CTP-488 — On-box / Coolify oneshot Slice A poll CLI

Date: 2026-09-08  
Linear: [CTP-488](https://linear.app/rcjt-studio/issue/CTP-488)  
Base: `91ffdbfc` (#219)

## Landed

- Shared `listPollableSliceABronnen` used by `schedule-slice-a-polls` and the CLI
- `apps/worker/scripts/oneshot-slice-a-polls.ts` wrapping `runPollBronOnce`
  (same body as Trigger `poll-bron` → `runPollBron`, no Trigger SDK)
- Safe defaults: `--list` / `--dry-run`; `--run` required; optional `--bron` / `--limit`
- Runbook `docs/runbooks/slice-a-oneshot-poll.md`
- Motian untouched; `/bronnen/overview` unshadow not in scope

## Verify

```bash
bun test apps/worker/src/oneshot-slice-a-polls.spec.ts \
  apps/worker/src/effect/effect.spec.ts
bun run gate
```
