---
name: verify-job-intelligence
description: Drive the Catapulze Job Intelligence Next.js UI (port 3001) and Hono/tRPC API (port 3000) the way a user does. Use when proving home command center, job search, login/signup/dashboard, or sign-out against a real local instance.
---

# Verify Job Intelligence

Scripted control for the Catapulze Job Intelligence stack: Next.js web on **3001**, Hono + tRPC + Better Auth on **3000**. Job search at `/jobs` is user-facing (fixture adapter with `NEXT_PUBLIC_USE_FIXTURES=1`, or REST when unset). Vacancy ingest pipelines, approvals, and Spott export remain planning docs without drive targets here.

Run every command from the repository root. The parent directory `clients:catapulze` contains a colon; never prepend an absolute `node_modules/.bin` to `PATH`.

```bash
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs launch
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs doctor
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs snapshot home-command-center
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs stop
```

## Launch

Preconditions: `apps/server/.env` and `apps/web/.env` exist (copy from `.env.example`). Server needs a reachable `DATABASE_URL` and a 32+ character `BETTER_AUTH_SECRET`. Web needs `NEXT_PUBLIC_SERVER_URL=http://localhost:3000`. Set `CORS_ORIGIN=http://localhost:3001` on the server so browser and API origins match. For `/jobs` without Manticore, set `NEXT_PUBLIC_USE_FIXTURES=1` in `apps/web/.env`.

`launch` starts `bun run dev:server` and `bun run dev:web` as a detached process group and records PIDs in `.cursor/skills/verify-job-intelligence/.run/pids.json`.

Ready when:

- `GET http://localhost:3000/` returns body `OK`
- `GET http://localhost:3001/` is 200 and the HTML contains `Job Intelligence`

Ports **3000** and **3001** are shared defaults. Two instances cannot run side by side. If those ports already answer and the pidfile is not ours, `launch` refuses. Do not start a second copy.

Teardown is `control.mjs stop` (see Cleanup).

## Doctor

Read-only. Answers "is this instance worth driving?"

```bash
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs doctor
```

Requires:

- Server root `OK`
- Web HTML contains `Job Intelligence`
- `GET http://localhost:3000/trpc/healthCheck` is 200 and the body contains `OK`
- Either this skill owns the PIDs, or `JI_VERIFY_ALLOW_SHARED=1` is set for a user-started `bun run dev`

Run doctor first whenever anything looks off. A shared instance is read-only: never `stop` it.

## Drive

Read `features/README.md`, then the matching feature file. Prefer those recipes over improvising.

Harness:

- HTTP through `control.mjs http <url>` or `control.mjs snapshot <feature-id>`
- Browser (Cursor browser tools, or Playwright headless) for client-rendered auth UI and job-search interactions — curl only sees SSR shells on `/login`
- Stable handles:
  - Home H1 `Vind de juiste opdracht vóór de rest.`, link `Open job search` → `/jobs`, brand `Job Intelligence`
  - Header nav `Overzicht` → `/`, `Zoeken` → `/jobs`, role-gated `Bronnen` → `/bronnen` (`operator`|`admin` only), button `Inloggen` → `/login`, menu item `Uitloggen`
  - Jobs search label `Zoek opdrachten met Boolean-logica`, results `aria-label="Zoekresultaten"`
  - Jobs active-filter chips: each chip removes one filter, `Alles wissen` resets query and filters
  - Jobs pagination buttons `Vorige` / `Volgende` with accessible names `Vorige pagina` / `Volgende pagina`
  - Login heading `Welcome Back`, labels `Email` / `Password`, button `Sign In` (public sign-up disabled — no `Create Account` / `Sign Up` UI)
  - Dashboard paragraph `Welcome <name>`, live overview headings or its loading/error/empty state
  - Theme toggle `sr-only` name `Thema wijzigen`, menu items `Licht` / `Donker` / `Systeem`

The UI ships the approved dark console design and `next-themes` defaults to
**dark**, so a fresh browser profile renders dark even on a light-mode host.
That is the expected baseline for screenshots; only a stored `theme=light`
preference or picking `Licht` renders the light palette.

Drive at `http://localhost:3001` (not `127.0.0.1`). Next.js 16 dev blocks `_next` chunks for mismatched hostnames. Match `CORS_ORIGIN` and `NEXT_PUBLIC_SERVER_URL` to `localhost` as in `.env.example`.

Do not call tRPC `privateData` from a test-only client and call that a dashboard proof. The user path is `/login` then `/dashboard`.

Public email/password sign-up is disabled (`disableSignUp: true`). Verify absence of sign-up UI and API rejection; do not drive a public sign-up flow. Provisioned accounts (`auth:provision`) are required for sign-in submit and sign-out proofs.

## Evidence

Proof artifacts live in `.cursor/skills/verify-job-intelligence/artifacts/<feature-id>/`. Cleanup must not delete them. **Never commit proof assets** to a product branch.

### Default format

A **short screen recording is the default**; a screenshot suffices only when the change is static (renamed label, new field present). Record the actual user interaction on this running instance — not a tRPC-only or curl shortcut.

**Recorder:** Playwright `recordVideo` / `video: 'on'` against the live-verify instance (`launch` + `doctor` first). One test or clip per claim. Wait on asserted UI states, never sleeps.

**Format:** Transcode Playwright's VP8/WebM to H.264 MP4 before attaching to a PR (GitHub and Linear preview MP4 reliably):

```bash
ffmpeg -i artifacts/<feature-id>/clip.webm \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart \
  artifacts/<feature-id>/clip.mp4
```

### Inspect before attach

Open every capture and confirm the asserted state is visible in frame. Re-shoot if it is not. File-exists, non-zero duration, and test exit 0 all pass on a blank window — uninspected artifacts are not verification.

Captures run against seeded/fixture data only. Never screenshot Motian production, real vacancy/aanvraag payloads, credentials, or PII. Sanitize before attaching.

### PR attachment

Label each clip with the exact claim it proves and which code path. Use Before/After pairs for fixes. Check the installed CLI and the actual attachment flag before posting:

```bash
gh --version
gh pr comment --help | rg -- '--attach|--body-file'
gh pr comment --body-file proof.md --attach proof.mp4
```

`proof.md` is an example body file containing the exact claim and code path; `proof.mp4` is an example artifact path. Follow AGENTS.md **Visual evidence** for GitHub CLI version/support, image-only alt-text syntax (video attachments have none), authentication, fallback, and attachment readback guidance. Reference the proof in the linked Linear issue when one exists. Read the posted PR or comment back and confirm the attachment renders in the intended context; command success alone is not proof.

If visual proof is infeasible, state the exact blocker in the PR — never skip silently.

### Capture standards

- Exercise the real user path (browser or the same HTTP the browser uses)
- Capture the action and the resulting state (`home.html` plus `trpc-healthCheck.txt`, or a screenshot/video plus ARIA snapshot)
- For mutations, read back from a second user-facing view (dashboard paragraph `Welcome <name>`, or session cookie + `GET /dashboard` not redirecting to `/login`)
- Record the feature ID in `meta.json`

tRPC `healthCheck` is verified by doctor and snapshot `trpc-healthCheck.txt`; home no longer renders an on-page API status section.

**Refactors are not exempt.** Tests can stay green while visible behavior moves; do not substitute passing test output for user-visible evidence.

## Cleanup

```bash
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs stop
```

Sends SIGTERM (then SIGKILL) to the process groups recorded in `pids.json` only. Never `pkill` turbo, bun, or next. Leaves `artifacts/` in place. If doctor ran under `JI_VERIFY_ALLOW_SHARED=1`, do not stop.

## Helpers

```bash
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs launch
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs doctor
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs snapshot home-command-center
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs drive
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs http http://localhost:3001/jobs
bun .cursor/skills/verify-job-intelligence/scripts/control.mjs stop
```
