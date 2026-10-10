# Auth access and provisioning

The web UI, REST capabilities, and MCP capabilities share one Better Auth
session boundary. A caller cannot choose its own subject or role.

## Runtime contract

- Browser requests use the Better Auth session cookie with
  `credentials: "include"`. The web client never sends an `Authorization`
  role header. Session cookies are `HttpOnly` and `SameSite=Lax` (plus `Secure`
  in production).
- An unsafe REST request that carries a session cookie must send an `Origin`
  header that exactly equals `CORS_ORIGIN`. A foreign or missing origin is
  rejected with `403 CSRF_REJECTED` before the session lookup, body read, or
  capability invocation. Non-browser automation must use a signed Better Auth
  bearer; a cookie plus no origin is intentionally unsupported for writes.
- Every request that sends an `Origin` header must match `CORS_ORIGIN`,
  including bearer-authenticated MCP requests. A non-browser bearer client may
  omit `Origin`; sending a foreign value is always rejected before parsing or
  authentication.
- REST and MCP resolve every request with `auth.api.getSession` and force a
  database-backed check. Expired, revoked, unknown, or malformed sessions fail
  closed.
- A browser session becomes a `user` principal. A signed bearer session
  becomes an `agent` principal. If an `Authorization` header is present, its
  lookup cannot fall back to a valid browser cookie.
- The role comes from the server-owned `user.role` column. Better Auth marks
  this additional field `input: false`, so sign-up and update bodies cannot set
  it. Allowed values are `recruiter`, `operator`, `admin`, and `approver`.
  An `approver` receives the full Slice A read surface (`PERM_SLICE_READ`)
  plus approval and export permissions, but not the recruiter-only
  `read_raw` or mutating capabilities (CTP-655).
- Public email/password sign-up is disabled. `/jobs` performs no capability
  calls without a session and shows `Log in om opdrachten te bekijken`.

The MCP bearer is not an application JWT. Better Auth 1.7.1 signs the opaque
session token with HMAC-SHA256 and `BETTER_AUTH_SECRET`; `requireSignature` is
enabled. Better Auth then resolves that token against the session store, which
enforces expiry and revocation. Keep bearer tokens in 1Password, rotate/revoke
them like passwords, and never place them in source control or command-line
arguments.

## Supported clients

The supported MCP client model is first-party, operator-controlled automation
that uses a signed Better Auth session bearer for an existing Catapulze user.
The repository contains the browser UI plus REST and MCP server transports; it
does not contain or certify a generic third-party MCP client integration. The
browser UI continues to use its human cookie session and is not converted into
an agent identity.

The application-auth owner maintains Better Auth, session storage, role
assignment, expiry, and revocation. The MCP transport owner accepts only the
resolved principal and enforces the same capability permissions, approval,
idempotency, and audit paths as REST. The operator who provisions a client owns
the client version, credential storage, and prompt revocation when access is no
longer needed.

### Onboard and scope a first-party MCP client

1. Provision a new named human user through the operator-only process below
   with the least-privileged role needed for the automation. An existing user
   may be selected only when it already has the required role; the provisioning
   CLI refuses existing emails and cannot change roles. Otherwise stop until an
   audited role-management path exists. Do not create a shared service-admin
   identity.
2. Establish a normal Better Auth session over HTTPS from a trusted first-party
   client. Capture the signed session token from Better Auth's `set-auth-token`
   response header directly into 1Password or process-scoped secret injection.
   Never copy it into a shell argument, repository, issue, log, or screenshot.
3. Send `Authorization: Bearer <signed-session>` to the canonical `/mcp`
   resource. Omit `Origin` for non-browser automation, or send exactly the
   configured `CORS_ORIGIN`. A bearer is scoped to the current user identity,
   current server-owned role, session expiry, and the capability registry; it
   is not a separately configurable OAuth scope.
4. Verify an allowed read and a role-forbidden write with synthetic data. A
   write that is otherwise authorized still passes through the registry's
   idempotency, approval, snapshot, and audit rules.

### Revoke client access

The supported revocation unit is the individual Better Auth session used by
the client. From that client, send an authenticated `POST /api/auth/sign-out`
with the signed session bearer sourced from process-scoped secret injection;
do not place the bearer in the URL or a command argument. Remove the token from
the client's secret store after sign-out succeeds. The next MCP call performs
a fresh database-backed session lookup and must fail, as covered by
`packages/auth/src/security-config.spec.ts`.

Repeat sign-out for each separately provisioned client session. Catapulze does
not currently expose an audited account-disable, role-management, or
all-sessions revocation operation, so this runbook does not claim one. If the
operator no longer controls a session bearer, stop and add a reviewed
administrative revocation path before claiming that session has been revoked.

This first-party contract does not implement MCP OAuth protected-resource
metadata, authorization-server discovery, OAuth scopes, Resource Indicators,
or third-party consent. Those RJC-441 OAuth acceptance criteria are
inapplicable while generic external MCP clients remain unsupported. Supporting
such clients later requires a separate accepted design and end-to-end OAuth
implementation; a signed Better Auth session bearer must not be advertised as
OAuth compliance.

## Migration dependency

Apply `0013_durable_user_writes` first, then
`0014_auth_user_role`. Migration `0014` backfills existing users to
`recruiter`, adds a non-null default, and adds a database check constraint for
the allowed roles. This ordering is a code-derived expectation, not proof that
production has applied either migration. Use the deployed-SHA journal,
current-snapshot rehearsal, explicit approval, and privacy-safe role readbacks
in [neon-migration-catchup.md](neon-migration-catchup.md). Do not deploy the
auth code before both migrations are proven present.

## Provision the first user

The only supported bootstrap path is the unmounted operator CLI. It has no HTTP
route. Run it from a trusted server shell with the production environment and
1Password injection. Do not pass any value as a command argument.

Required one-shot environment names:

- `AUTH_BOOTSTRAP_ENABLED=1`
- `AUTH_BOOTSTRAP_CONFIRM=PROVISION_AUTH_USER`
- `AUTH_BOOTSTRAP_EMAIL`
- `AUTH_BOOTSTRAP_NAME`
- `AUTH_BOOTSTRAP_PASSWORD`
- `AUTH_BOOTSTRAP_ROLE`

With those values supplied through the local 1Password environment file:

```bash
op run --env-file=apps/server/.env.1password -- bun run --filter server auth:provision
```

The command uses Better Auth's password API and hashing. It refuses an existing
email without changing that user, reads the stored role back from Postgres, and
prints only non-secret JSON evidence:

```json
{"created":true,"role":"recruiter","roleVerified":true,"status":"provisioned"}
```

Email is trimmed and lowercased before both the existence lookup and Better Auth
signup. An existing or concurrently created email returns `already_exists` and
exit code 2.

If Better Auth created the account but the stored role cannot be verified, the
command exits 3 and prints explicit reconciliation evidence:

```json
{"code":"ROLE_READBACK_FAILED","created":true,"roleVerified":false,"status":"reconciliation_required"}
```

Inspect and reconcile that existing account before retrying; do not assume the
create was rolled back. Invalid gates, roles, or create failures exit 1 with a
fixed error code. If database connection cleanup fails after the outcome was
already printed, the stdout evidence and its exit code (0, 2, or 3) are
preserved and only the sanitized warning
`{"code":"DATABASE_CLOSE_FAILED","status":"warning"}` is written to stderr.
No output includes the email, name, password, database error,
or token. Remove the bootstrap variables from the process environment
immediately after the command; normal server startup never reads or needs them.
