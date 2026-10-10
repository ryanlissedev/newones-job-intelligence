# Job Intelligence verification map

This directory is the maintained source for verifying the user-facing Catapulze Job Intelligence web app and its Hono/tRPC API. Read this index before driving the app, then use the matching feature file as the recipe.

The checked-in app includes authentication, a recruiter home command center, Boolean job search (fixture or REST adapter), a private dashboard, and the operator-only `/bronnen` ingest monitor. Vacancy ingest workers, approvals, and Spott export remain planning docs without dedicated feature files here.

## Baseline preconditions

- Web at `http://localhost:3001`, API at `http://localhost:3000`.
- `apps/server/.env` and `apps/web/.env` are present.
- For `/jobs` verification without Manticore, set `NEXT_PUBLIC_USE_FIXTURES=1` in `apps/web/.env` (not listed in `apps/web/.env.example`; optional for local verify only).
- Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs doctor` and require `ok: true`.
- Never `stop` an instance this skill did not `launch`.
- Ports 3000/3001 cannot be shared by two copies. If a human already has `bun run dev` up, set `JI_VERIFY_ALLOW_SHARED=1` and drive read-only.
- Use `localhost` hostnames in the browser and in `CORS_ORIGIN` / `NEXT_PUBLIC_SERVER_URL`. Opening `127.0.0.1:3001` in Next.js 16 dev blocks client chunks.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Prefer headings, labeled inputs, link text, and `aria-label` over CSS or DOM position.
- Treat helper commands as literal.
- Public email/password sign-up is disabled (`disableSignUp: true` in auth config). Do not expect a `Create Account` UI or a passing public sign-up flow.
- Do not delete proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- **Default:** short screen recording (Playwright `video: 'on'`, one clip per claim); screenshot only for static UI. Transcode WebM → H.264 MP4 before PR attach (see SKILL.md **Evidence**).
- Open every capture before attaching; re-shoot if the asserted state is not in frame.
- UI proof includes saved HTML, a screenshot, or a video with expected copy visible.
- API proof includes status code and body.
- Record the feature ID in `artifacts/<id>/meta.json`.
- Report an unreachable path with the unmet prerequisite. Do not mark it verified via a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with control.mjs`, `Gotchas`.

## Features

- [Home command center](./home-command-center.md) covers the public `/` recruiter landing, authenticated live overview, and doctor tRPC `healthCheck`.
- [Job search](./job-search.md) covers Boolean search at `/jobs` (fixtures or REST).
- [Dashboard guard](./dashboard-guard.md) covers unauthenticated `/dashboard` redirect to `/login`.
- [Sign up](./sign-up.md) covers disabled public sign-up (no UI path; Better Auth rejects email sign-up).
- [Sign in and sign out](./sign-in-and-sign-out.md) covers returning users and clearing the session.
- [Bronnen operator dashboard](./bronnen-operator-dashboard.md) covers the role-gated `/bronnen` operator monitor (overview KPIs, window links, runs navigation).
