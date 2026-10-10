import {
  permissionsForRole,
  ROLE_ADMIN,
  ROLE_APPROVER,
  ROLE_OPERATOR,
  ROLE_RECRUITER,
} from "@ji/application/registry";
import type { InvocationPrincipal, SliceARole } from "@ji/application/registry";

interface AuthenticatedSession {
  readonly session: {
    readonly expiresAt: Date | string;
  };
  readonly user: {
    readonly id: string;
    readonly role?: string | null;
  };
}

export type SessionLookup = (
  headers: Headers
) => Promise<AuthenticatedSession | null>;

export interface AuthOperationalEvent {
  readonly code: "AUTH_SESSION_LOOKUP_UNAVAILABLE";
  readonly reason: string;
  readonly requestId: string;
}

const MAX_REASON_LENGTH = 120;

/**
 * Bounded, operator-only description of a lookup failure: the error class and
 * its machine code (e.g. `PostgresError/ECONNREFUSED`). Free-text messages are
 * deliberately excluded so no upstream detail can leak through logs.
 */
export const describeLookupFailure = (error: Error): string => {
  const code =
    "code" in error && error.code !== undefined && error.code !== null
      ? String(error.code)
      : "";
  const reason = code === "" ? error.name : `${error.name}/${code}`;
  return reason.slice(0, MAX_REASON_LENGTH);
};

export type AuthOperationalLogger = (event: AuthOperationalEvent) => void;

export type PrincipalResolution =
  | {
      readonly ok: true;
      readonly principal: InvocationPrincipal | null;
    }
  | {
      readonly error: {
        readonly code: "AUTH_SESSION_UNAVAILABLE";
        readonly message: "Authentication service unavailable";
        readonly requestId: string;
      };
      readonly ok: false;
    };

export type PrincipalResolver = (
  headers: Headers,
  requestId: string
) => Promise<PrincipalResolution>;

export interface CookieAuthOriginPolicy {
  readonly allowedCookieOrigin: string;
}

export const hasAllowedCookieOrigin = (
  method: string,
  headers: Headers,
  allowedOrigin: string
): boolean => {
  const origin = headers.get("Origin");
  if (origin !== null) {
    return origin === allowedOrigin;
  }

  const requiresCookieOrigin =
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    headers.has("Cookie") &&
    !headers.has("Authorization");
  return !requiresCookieOrigin;
};

const isSliceARole = (value: string | null | undefined): value is SliceARole =>
  value === ROLE_RECRUITER ||
  value === ROLE_OPERATOR ||
  value === ROLE_ADMIN ||
  value === ROLE_APPROVER;

const resolveExpiry = (expiresAt: Date | string): number =>
  expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);

const principalFromSession = (
  session: AuthenticatedSession | null,
  kind: InvocationPrincipal["kind"],
  now: Date
): InvocationPrincipal | null => {
  if (!session) {
    return null;
  }
  const subjectId = session.user.id.trim();
  const expiresAt = resolveExpiry(session.session.expiresAt);
  if (
    !subjectId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime() ||
    !isSliceARole(session.user.role)
  ) {
    return null;
  }

  return Object.freeze({
    kind,
    permissions: permissionsForRole(session.user.role),
    subjectId,
  });
};

/**
 * Resolve a principal only after Better Auth has validated the cookie or
 * signed bearer session. Caller-provided roles and subjects are never parsed.
 */
export const createSessionPrincipalResolver =
  (
    lookupSession: SessionLookup,
    now: () => Date = () => new Date(),
    onOperationalEvent?: AuthOperationalLogger
  ): PrincipalResolver =>
  async (headers, requestId): Promise<PrincipalResolution> => {
    try {
      const hasAuthorization = headers.has("Authorization");
      const lookupHeaders = new Headers(headers);
      if (hasAuthorization) {
        // Never allow a bad Authorization header to fall back to a valid
        // browser cookie. Better Auth must validate this bearer on its own.
        lookupHeaders.delete("Cookie");
      }
      const session = await lookupSession(lookupHeaders);
      return {
        ok: true,
        principal: principalFromSession(
          session,
          hasAuthorization ? "agent" : "user",
          now()
        ),
      };
    } catch (error) {
      onOperationalEvent?.({
        code: "AUTH_SESSION_LOOKUP_UNAVAILABLE",
        reason:
          error instanceof Error
            ? describeLookupFailure(error)
            : "UnknownError",
        requestId,
      });
      return {
        error: {
          code: "AUTH_SESSION_UNAVAILABLE",
          message: "Authentication service unavailable",
          requestId,
        },
        ok: false,
      };
    }
  };

export const createRequestId = (): string => crypto.randomUUID();
