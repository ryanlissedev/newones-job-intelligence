# ADR-0012: First-party signed sessions for MCP client access

- Status: Accepted
- Date: 2026-09-05
- Issues: RJC-441, RJC-439

## Context

Catapulze exposes the same capability registry through REST and MCP. Better
Auth already validates browser cookies and HMAC-signed, opaque session bearers
against the session store on every request. The server then derives the actor
and permissions from the current server-owned user role. Expiry, revocation,
role changes, capability approval, idempotency, snapshot binding, and audit are
therefore checked at invocation time rather than delegated to a client claim.

The repository inventory contains the Catapulze web client and the REST and MCP
server transports. It has no supported generic third-party MCP client,
authorization server, OAuth protected-resource metadata, delegated grant
store, or external-consent flow. No established product need currently
requires that larger public-client surface.

## Decision

MCP access is limited to first-party, operator-controlled clients using a
signed Better Auth session bearer for an existing Catapulze user. The bearer
represents that user's session and receives only the permissions of the user's
current role. It is not an application JWT, OAuth access token, independent
service account, or configurable delegated scope.

Human browser login remains cookie-based and creates a `user` principal. A
validated bearer creates an `agent` principal. When `Authorization` is present,
the server removes cookies before session lookup so an invalid bearer can never
fall back to a valid human session. Any request that presents an `Origin` must
match the configured web origin; unsafe cookie-only requests additionally
require that origin. Bearer-only non-browser requests may omit `Origin`.

## Responsibilities

- The application-auth owner maintains Better Auth signature requirements,
  session persistence, expiry/revocation, and server-owned roles.
- The MCP transport owner authenticates each call, exposes no caller-supplied
  role or subject, and routes through the shared capability registry.
- Capability owners retain authorization, approval, idempotency, snapshot, and
  audit invariants. Authentication never bypasses those controls.
- The provisioning operator assigns the least-privileged role, records the
  supported client/version outside the repository, stores the bearer through
  the existing secret process, and revokes it when no longer needed.

## Consequences

An operator can onboard a controlled client without adding another identity
platform. Revocation and role changes take effect on the next call through the
database-backed lookup. A shared service-admin identity and unbounded consent
are prohibited.

Generic external clients are unsupported. The OAuth-specific RJC-441 criteria
for RFC 9728 discovery and challenge behavior, issuer/audience/scope and RFC
8707 validation, RFC 9207 mix-up protection, client registration, and an
external discovery-to-revocation fixture are marked not applicable for this
decision. Their absence is not presented as OAuth support or as an auth bypass.
If a generic-client need is established, a new ADR must choose a maintained
authorization server, canonical HTTPS resource, issuer-bound client model, and
least-privilege grant lifecycle before public access is offered.

## Verification

Focused tests cover all supported roles, expiry, revocation, forged or unsigned
credentials, bearer-to-cookie fallback prevention, and Origin rejection before
request-body parsing. The runbook documents onboarding, scope, secure token
handling, role changes, and revocation. Live production configuration and a
named external-client interoperability flow are intentionally outside this
decision's evidence.

## References

- [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207)
- [Auth access and provisioning](../runbooks/auth-access.md)
