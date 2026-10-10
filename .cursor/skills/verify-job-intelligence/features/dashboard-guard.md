# Dashboard guard

Visiting the dashboard without a session sends the user to login. The guard is implemented as a page-level `redirect("/login")` in `apps/web/src/app/dashboard/page.tsx`, not Next.js middleware. The dashboard is not a public page and has no header nav link. Signed-out header nav shows `Overzicht` and `Zoeken` only; `Bronnen` appears for signed-in `operator` or `admin` (see [Bronnen operator dashboard](./bronnen-operator-dashboard.md)).

## Sub-features

- `guard-redirect` unauthenticated `GET /dashboard` redirects to `/login` (307/302).
- `guard-login-visible` the login route then shows heading `Welcome Back` (sign-in only; public sign-up is disabled).

## How to get to it (user POV)

- Open `http://localhost:3001/dashboard` directly while signed out.

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.
- No Better Auth session cookies are sent.

- **Unauthenticated fetch.** Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs http http://localhost:3001/dashboard`. Status is `307` or `302` and the `location` header contains `/login`. Doctor also reports `dashboardLocation: "/login"`.
- **Login shell.** Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs http http://localhost:3001/login`. Status `200`. In a browser, heading is `Welcome Back` (client-rendered). Page must not show `Create Account` or a sign-up switch.
- **Proof.** Save the dashboard response headers and browser login evidence under `artifacts/dashboard-guard/` (`meta.json` plus screenshot or `login.html`).

## Gotchas

- A 200 dashboard HTML that still says `Welcome` is a logged-in session, not a passing guard.
- `/login` shows **Sign In** only (`Welcome Back`). There is no default `Create Account` view and no toggle to reach one.
- There is no `Dashboard` link in the header; do not follow a stale map that references one.
- Do not expect middleware-based auth on `/dashboard`; assert the page redirect response.
