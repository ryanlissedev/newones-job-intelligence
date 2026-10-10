# Sign up

Public email/password sign-up is **disabled**. Better Auth sets `disableSignUp: true` in `packages/auth/src/security-config.ts`. The `/login` route mounts only `SignInForm` (`Welcome Back`); `SignUpForm` (`Create Account`) exists in the repo but is not imported. New accounts are provisioned operator-side via the unmounted CLI `auth:provision` (see `docs/runbooks/auth-access.md`).

## Sub-features

- `signup-disabled-ui` `/login` shows heading `Welcome Back` only — no `Create Account`, no `Sign Up` button, no `Need an account? Sign Up` switch.
- `signup-disabled-api` `POST /api/auth/sign-up/email` with valid JSON is rejected (403 or equivalent error body) while `disableSignUp` remains true.
- `signup-bootstrap-note` document-only: operator bootstrap is outside this skill's drive scope; cite `docs/runbooks/auth-access.md` when reporting provisioning prerequisites.

## How to get to it (user POV)

- Open `/login` via header button `Inloggen` or directly.
- There is no user-facing path to create an account. Do not hunt for a hidden sign-up toggle.

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.

Browser path:

- **Login shell.** Load `/login`. Heading is `Welcome Back`. Page does **not** contain `Create Account`, `Sign Up`, or `Already have an account? Sign In`.
- **API rejection.** `POST http://localhost:3000/api/auth/sign-up/email` with `{ "name": "Verify User", "email": "verify+disabled@example.test", "password": "verify-pass-8" }` returns a non-success status (400/403) with an error such as `EMAIL_PASSWORD_SIGN_UP_DISABLED` — not a session cookie.
- **Proof.** Save screenshot or HTML under `artifacts/sign-up/` with `meta.json` recording `disableSignUp: true` and the API status/body snippet.

Do **not** mark `signup-submit` or `signup-dashboard` as verified via public sign-up. Those flows require a provisioned account (`auth:provision` / `AUTH_BOOTSTRAP`), covered under sign-in.

## Gotchas

- `SignUpForm` remains in `apps/web/src/components/sign-up-form.tsx` as orphaned code — absence from `/login` is the live behavior to verify.
- A stale map that expects `/login` to open on `Create Account` is wrong; guard and sign-in recipes must expect `Welcome Back`.
- Duplicate-email toasts and dashboard landing after sign-up are **not** applicable while public sign-up is disabled.
- Header chrome is Dutch (`Inloggen`, `Uitloggen`); the sign-in form copy remains English.
