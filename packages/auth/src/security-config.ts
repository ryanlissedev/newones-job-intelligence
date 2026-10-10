export const AUTH_USER_ROLES = [
  "recruiter",
  "operator",
  "admin",
  "approver",
] as const;

export type AuthUserRole = (typeof AUTH_USER_ROLES)[number];

export const DEFAULT_AUTH_USER_ROLE = "recruiter" satisfies AuthUserRole;

/**
 * Better Auth owns this field. `input: false` prevents sign-up, profile
 * mapping, and user-update bodies from assigning or escalating a role.
 */
export const AUTH_USER_ROLE_FIELD = Object.freeze({
  defaultValue: DEFAULT_AUTH_USER_ROLE,
  input: false,
  required: true,
  returned: true,
  type: [...AUTH_USER_ROLES],
});

export const AUTH_BEARER_OPTIONS = Object.freeze({
  requireSignature: true,
});

export const AUTH_EMAIL_PASSWORD_OPTIONS = Object.freeze({
  disableSignUp: true,
  enabled: true,
});

export interface AuthAdvancedCookieConfig {
  crossSubDomainCookies?: {
    domain: string;
    enabled: true;
  };
  defaultCookieAttributes: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const hostnameOf = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isLoopbackHost = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");

/**
 * Derive a shared cookie Domain for Better Auth cross-subdomain cookies from
 * BETTER_AUTH_URL (api host) and CORS_ORIGIN (app host). Returns null when
 * hosts are loopback, identical, or lack a shared multi-label parent — so
 * local/dev stays host-only while demo sslip siblings (app.* + api.*) share
 * `.203-0-113-10.sslip.io`.
 */
export const resolveCrossSubDomainCookieDomain = (
  betterAuthUrl: string,
  corsOrigin: string
): string | null => {
  const authHost = hostnameOf(betterAuthUrl);
  const appHost = hostnameOf(corsOrigin);
  if (!(authHost && appHost)) {
    return null;
  }
  if (isLoopbackHost(authHost) || isLoopbackHost(appHost)) {
    return null;
  }
  if (authHost === appHost) {
    return null;
  }

  const authLabels = authHost.split(".");
  const appLabels = appHost.split(".");
  let commonSuffixLength = 0;
  while (
    commonSuffixLength < authLabels.length &&
    commonSuffixLength < appLabels.length &&
    authLabels[authLabels.length - 1 - commonSuffixLength] ===
      appLabels[appLabels.length - 1 - commonSuffixLength]
  ) {
    commonSuffixLength += 1;
  }

  // Require a real parent (e.g. example.com / 203-0-113-10.sslip.io), not a
  // bare TLD, and a distinguishing left-side label on each host.
  if (commonSuffixLength < 2) {
    return null;
  }
  if (
    authLabels.length <= commonSuffixLength ||
    appLabels.length <= commonSuffixLength
  ) {
    return null;
  }

  const parent = authLabels
    .slice(authLabels.length - commonSuffixLength)
    .join(".");
  return `.${parent}`;
};
