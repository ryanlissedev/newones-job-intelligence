# Sign in and sign out

A returning user signs in from `Welcome Back`, sees the dashboard, then signs out and returns to home without a session. Public sign-up is disabled; `/login` mounts only the sign-in form (no switch to `Create Account`).

## Sub-features

- `signin-open` `/login` shows heading `Welcome Back`, labels `Email` / `Password`, button `Sign In`.
- `signin-submit` valid email/password for a **provisioned** account reaches `/dashboard` with paragraph `Welcome <name>` and the live overview (or its truthful loading/error/empty state).
- `signout` the user-menu button showing the account name exposes `Uitloggen` and returns to `/`.

## How to get to it (user POV)

- Header button `Inloggen` while signed out → `/login` (`Welcome Back`).
- Open `/login` directly.
- Signed-in header button showing the user's name → `Uitloggen`.

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.
- **For `signin-submit` and `signout`:** an existing provisioned account in the database (CLI `auth:provision` or prior bootstrap). Without one, mark those sub-features `verified-unreachable` with prerequisite `provisioned account / AUTH_BOOTSTRAP` and still drive the reachable shell checks below.

Browser path:

- **Open sign-in.** Load `/login`. Heading is `Welcome Back`. No `Create Account`, `Sign Up`, or sign-up switch copy.
- **Submit (when provisioned).** Fill labeled `Email` and `Password`, choose `Sign In`. Land on `/dashboard` with paragraph `Welcome <name>` and the live overview (or its truthful loading/error/empty state).
- **Sign out (when provisioned).** Open the header button whose name is the user name, choose `Uitloggen`. URL becomes `/`. Header shows button `Inloggen` again.
- **Proof.** Save screenshot/HTML under `artifacts/sign-in-and-sign-out/`. When provisioned: after sign-in, `GET /dashboard` with cookies is 200; after sign-out, `GET /dashboard` redirects to `/login`. When not provisioned: record `signin-submit` and `signout` as unreachable in `meta.json` with the prerequisite.

## Gotchas

- There is no sign-up/sign-in toggle on `/login`. Do not look for `Already have an account? Sign In` or `Need an account? Sign Up`.
- Sign-out `onSuccess` pushes `/`. Proving sign-out requires a follow-up `/dashboard` request that redirects.
- Shared local sessions: signing out here signs out that browser profile on 3001.
- Dashboard welcome is a `<p>Welcome {name}</p>`, not a heading.
- Do not look for menu item `Sign Out`; the live label is `Uitloggen`.
- The overview is client-rendered after the server guard; wait for its live result, error, or empty state after the welcome paragraph.
