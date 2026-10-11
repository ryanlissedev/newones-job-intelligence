# Tester-army e2e: scenarios and visual regression

Two suites run on the `e2e` runner (tester-army, `npx e2e` / `bun run test:e2e*`).

| Suite | Config | Target | Data | Visual baselines |
| --- | --- | --- | --- | --- |
| Fixtures | `e2e.fixtures.config.ts` | local production build of a copied `.e2e-fixtures/web` app in fixture mode + local auth stub | the 20 seeded fixture jobs, 3 fixture snapshots | committed in `tests/visual/baselines/fixtures/`, enforced |
| Live | `e2e.live.config.ts` | deployed web origin (`E2E_LIVE_WEB_URL`) | whatever is deployed; anonymous, read-only | seeded on the operator box, report-only, never committed |

## Fixture suite

```bash
bun run test:e2e:fixtures                    # scenarios + visual (enforce)
bun run test:e2e:fixtures --tag search       # one area; extra args go to `e2e run`
E2E_VISUAL=off bun run test:e2e:fixtures     # scenarios only
bun run test:e2e:fixtures:update-baselines   # re-render the committed baselines
```

`scripts/e2e/run-fixtures.sh`:

1. `scripts/e2e/fixtures-build.sh` copies the tracked and untracked non-ignored files from `apps/web` into `.e2e-fixtures/web`, symlinks its `node_modules`, and builds the copy with `NEXT_PUBLIC_USE_FIXTURES=1`. The app is not changed: the copy may be mutated by Next and uses its default `.next` dist directory. It skips the build while `HEAD`, the uncommitted `apps/web`/`packages` diff, untracked-file hashes, and the auth port are unchanged; `E2E_FIXTURES_REBUILD=1` forces it. A production build is used rather than `next dev`: deterministic CSS, no dev overlay, and no file watchers.
2. Generates a random per-run password for the stub user (`E2E_USER_FIXTURE_PASSWORD`, never printed) and sets `TZ=Europe/Amsterdam` (the web engine has no `timezoneId` option in `@e2e-dev/web` 0.11.2, Chromium inherits `TZ`).
3. Runs `e2e run --config e2e.fixtures.config.ts`. The target command `tests/fixtures/support/serve.ts` starts `tests/fixtures/support/auth-stub.ts` on `127.0.0.1:${E2E_FIXTURES_AUTH_PORT:-3310}` and `next start` on the runner-allocated port.
4. Runs `scripts/e2e/visual-compare.ts --suite fixtures --mode ${E2E_VISUAL:-enforce}`. When extra arguments select a partial run, it adds `--captured-only`, so baselines for pages not captured in that run are reported as `not-run`.

`E2E_VISUAL` (or the `E2E_VISUAL_MODE` alias for fixtures) must be `off`, `report`, `enforce`, or `update`; invalid values fail before the build or E2E runner starts. A run with no visual captures prints a notice and skips comparison.

The auth stub is a better-auth stand-in: `get-session` returns the fixture user for a `better-auth.session_token` starting with `e2e-valid`, and `null` for anything else (that is the expired-session case); `sign-in/email` only accepts `e2e.tester@example.test` with the per-run password; `sign-out` clears the cookie; every other endpoint answers 503, so data calls on `/dashboard` fail deterministically.

### Scenarios

| File | Tag | Covers |
| --- | --- | --- |
| `tests/fixtures/search.e2e.ts` | search | Boolean query narrows results and lands in `?q=`; deep link restores it; malformed query shows the syntax-error state; no-match query shows the empty state |
| `tests/fixtures/detail.e2e.ts` | detail | open a result: dialog with Herkomst and bron link, `?job=`; close removes it; `?job=job-001` deep link; browser back closes it |
| `tests/fixtures/filters.e2e.ts` | filters | Bron + Contract + Locatie combine (counts, URL params, active-filter chip), survive reload, "Alles wissen" resets to 20 |
| `tests/fixtures/session.e2e.ts` | session | sign in -> `/dashboard`, header user menu; sign out via "Uitloggen" -> anonymous header, cookie gone; wrong password -> error toast, stays on `/login`; empty submit -> field validation; expired session cookie -> `/dashboard` redirects to `/login` |
| `tests/fixtures/export.e2e.ts` | export | select a job -> "Snapshot maken" -> snapshot page -> approve with motivation -> "Exporteren naar Spott" -> export receipt; `/exports` lists the pending/approved/exported fixture snapshots |
| `tests/fixtures/visual.e2e.ts` | visual | baselines below |

### Visual pages (fixtures)

`login`, `home-public` (anonymous hero), `home-overview` (signed-in overview with fixture counts = the home dashboard), `opdrachten-list` (`/jobs`), `search-results` (`/jobs?q=Azure`), `detail` (`/jobs?job=job-001`), `exports`, `dashboard`, `snapshot` (freshly created snapshot).

## Live suite and the post-deploy hook

```bash
# Optional API origin; see the session test.
# Use a persistent directory on the operator box for live baselines.
E2E_LIVE_WEB_URL=https://<web origin> \
E2E_LIVE_API_URL=https://<api origin> \
E2E_VISUAL_BASELINE_DIR=/persistent/dir/live \
bun run test:e2e:live:verify
```

`scripts/e2e/live-verify.sh` validates `E2E_VISUAL` as `off`, `report`, `enforce`, or `update` before running anything. It then runs `e2e run --config e2e.live.config.ts` with `E2E_VISUAL=${E2E_VISUAL:-report}` and compares in the same mode. Exit code = the e2e run's; a visual diff only fails the hook when `E2E_VISUAL=enforce`. Plain `bun run test:e2e:live` (what the current verify step calls) is unchanged: the visual tests skip when `E2E_VISUAL` is unset.

Live tests added next to the existing four:

- `tests/live/session.e2e.ts`: a bogus/expired session cookie (plain and `__Secure-` names, on the web origin and on `E2E_LIVE_API_URL` when set) still gets the anonymous login wall on `/jobs` and the hero on `/`. Read-only.
- `tests/live/login-logout.e2e.ts`: real sign-in and sign-out with `credentials.live` (`E2E_USER_LIVE_USERNAME` / `E2E_USER_LIVE_PASSWORD`). Creating and deleting a session is a write on the deployed origin, so it is skipped with a reason unless `E2E_LIVE_ALLOW_SESSION_WRITES=1` and both credentials are set (dedicated test account only).
- `tests/live/visual.e2e.ts`: anonymous public chrome only, never vacancy data: `login`, `home` (hero), `jobs` (login wall), `bronnen` (access guard).

### Why live visual starts report-only

Live pages are rendered from deployed data, deploy-time assets and whatever the origin's session/permission state is. Baselines rendered locally from fixtures would never match, and committing captures of a deployed origin is not allowed (AGENTS.md, Visual evidence). So the first verify after this lands seeds baselines into `E2E_VISUAL_BASELINE_DIR` on the operator box (status `seeded`), later verifies compare against them and report `match`/`diff` in `.e2e/visual/summary.md` without failing the deploy check. Once a few deploys show stable `match` results, switch the hook to `E2E_VISUAL=enforce`. After an intended UI change, re-seed with `E2E_VISUAL=update`.

## Stability measures

- Fixed viewport 1280x800 (`web({ viewport })`), self-hosted fonts, `document.fonts.ready` and two animation frames before capture, animations/transitions/caret disabled, scrollbars and the toaster hidden, scroll to top.
- Frozen clock: `freezeClock()` intercepts document requests for the app origin, fetches them in the runner (redirects handed back to the browser) and injects a `Date` shim right after `<head>` anchored at `2026-09-01T09:00:00+02:00` that advances with `performance.now()`, so relative dates and "today" presets are stable. The shim is a plain source string: the runner transpiles test code with `__name` helpers that do not exist in the page, so `fn.toString()` would silently fail.
- Masks: solid `#FF00FF` boxes over every `time` element and `[data-visual-mask]`, plus per-page selectors for per-run values (snapshot uuid, created/approved timestamps, digests, "Geldig tot", the `/dashboard` data area that depends on the stubbed 503). With a dialog open only nodes inside it are masked. Seeded fixture rows and counts stay visible on purpose: they are the regression signal.
- Auth for visual pages uses `browser.setCookies`, never a secret fill, so screenshots stay allowed.
- Compare: `pixelmatch`, threshold `0.1`, anti-aliasing ignored, max diff ratio `0.001` (`E2E_VISUAL_MAX_DIFF_RATIO`), size mismatch fails. Output: `.e2e/visual/summary.json`, `summary.md`, `diff-<name>.png`.

Baselines are rendered on Linux Chromium (Playwright 1.63) in `Europe/Amsterdam`; another OS may differ by anti-aliasing. Regenerate them on the box that runs the suite.

## CI

`.github/workflows/ci.yml` job `e2e-fixtures` runs `bun run test:e2e:fixtures` on `ubuntu-latest` (Chromium via `playwright install --with-deps chromium`). The scenarios are enforced; the visual compare runs with `E2E_VISUAL=report`, because the committed baselines were rendered on the operator box and GitHub runners differ by 0.1-0.7% anti-aliasing (above the 0.001 threshold). The job is not required yet (`continue-on-error`, not in the release gate's required jobs). The `.e2e/` report and diffs are uploaded as the `e2e-fixtures-*` artifact. To enforce: re-render the baselines on a runner (or a matching container), then switch the step to `E2E_VISUAL=enforce` and make the job required.

## Post-deploy hook

The operator verify script runs `bun run test:e2e:live:verify` after each production deploy with `E2E_VISUAL=report` and a persistent `E2E_VISUAL_BASELINE_DIR` on the operator box. It never fails the deploy check.

## Rollback

- Visual only: `E2E_VISUAL=off` (fixtures and live), or leave the hook on `report`.
- Whole change: revert the PR.

## Known app issue (not fixed here)

In fixture mode the `/exports` "Bekijk" links point at non-UUID fixture ids (`fixture-snapshot-*`) and 404, because `/snapshots/[id]` requires a UUID.
