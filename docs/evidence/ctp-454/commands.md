# CTP-454 measurement commands

Testhost: `catapulze` (`<exe-dev-host>`)  
Worktree: `/home/exedev/src/wt-ctp-454-live`  
Branch: `ryan/ctp-454-live-measurement`

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/exedev/src/wt-ctp-454-live

bun install --frozen-lockfile

# Scaffold sanity
bun run effect-baseline:dry-run -- --run-kind cold

# Live fixture cohorts (native path)
bun run effect-baseline:measure -- --run-kind cold --iterations 12 --warmup 0 \
  --evidence-dir docs/evidence/ctp-454
bun run effect-baseline:measure -- --run-kind warm --iterations 12 --warmup 3 \
  --evidence-dir docs/evidence/ctp-454

# Gate subset for this package
bun test --max-concurrency 2 scripts/effect-baseline/
bun run check-types:effect-baseline
```

Motian / Coolify: untouched. No live provider env vars set (`SPOTT_LIVE`, `HERO_LIVE`, etc.).
