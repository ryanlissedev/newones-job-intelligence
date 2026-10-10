import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  AuthenticatedLiveJobsConfig,
  MutationLiveJobsConfig,
} from "./config";

export interface AuthenticatedSession {
  readonly subjectId: string;
}

export type AuthenticatedSessionVerifier = (
  config: AuthenticatedLiveJobsConfig
) => Promise<AuthenticatedSession>;

export type SessionVerifierJsonValue =
  | string
  | number
  | boolean
  | null
  | SessionVerifierJsonValue[]
  | { readonly [key: string]: SessionVerifierJsonValue };

interface ApplicableSessionCookie {
  readonly name: string;
  readonly value: string;
}

interface SessionResponse {
  readonly json: () => Promise<SessionVerifierJsonValue>;
  readonly redirected: boolean;
  readonly status: number;
  readonly url: string;
}

interface SessionVerifierDependencies {
  readonly fetcher?: (
    input: string,
    init: RequestInit
  ) => Promise<SessionResponse>;
  readonly now?: () => Date;
  readonly readStorageState?: (
    path: string
  ) => Promise<SessionVerifierJsonValue>;
}

const sessionVerifierJsonValueSchema: z.ZodType<SessionVerifierJsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(sessionVerifierJsonValueSchema),
      z.record(z.string(), sessionVerifierJsonValueSchema),
    ])
  );

const isSafeCookieValue = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 0x21 ||
      (codePoint >= 0x23 && codePoint <= 0x2b) ||
      (codePoint >= 0x2d && codePoint <= 0x3a) ||
      (codePoint >= 0x3c && codePoint <= 0x5b) ||
      (codePoint >= 0x5d && codePoint <= 0x7e)
    );
  });

const storageCookieSchema = z.object({
  domain: z.string(),
  expires: z.number().finite().optional(),
  name: z.string(),
  path: z.string(),
  secure: z.boolean(),
  value: z.string().min(1).refine(isSafeCookieValue),
});
const storageStateSchema = z.object({
  cookies: z.array(storageCookieSchema),
});
const sessionResponseSchema = z.object({
  session: z.object({
    expiresAt: z.string().datetime({ offset: true }),
  }),
  user: z.object({
    id: z.string().min(1).max(200),
  }),
});
const missingSessionResponseSchema = z.union([
  z.null(),
  z.object({ session: z.null(), user: z.null().optional() }),
]);

const readExternalStorageState = async (
  path: string
): Promise<SessionVerifierJsonValue> =>
  sessionVerifierJsonValueSchema.parse(
    JSON.parse(await readFile(path, "utf-8"))
  );

const defaultSessionFetcher = async (
  input: string,
  init: RequestInit
): Promise<SessionResponse> => {
  const response = await fetch(input, init);
  return {
    json: async () =>
      sessionVerifierJsonValueSchema.parse(await response.json()),
    redirected: response.redirected,
    status: response.status,
    url: response.url,
  };
};

const fail = (message: string): never => {
  throw new Error(`${message}; no browser evidence or writes were attempted.`);
};

const sessionCookieName = (apiUrl: URL): string =>
  apiUrl.protocol === "https:"
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";

const readApplicableSessionCookie = (
  storageState: SessionVerifierJsonValue,
  apiUrl: URL,
  now: Date
): ApplicableSessionCookie => {
  const parsed = storageStateSchema.safeParse(storageState);
  if (!parsed.success) {
    return fail("Better Auth storage state is unavailable or invalid");
  }
  const expectedName = sessionCookieName(apiUrl);
  const matches = parsed.data.cookies.filter((cookie) => {
    const expiresAt = cookie.expires ?? -1;
    const unexpired = expiresAt === -1 || expiresAt * 1000 > now.getTime();
    return (
      cookie.name === expectedName &&
      cookie.domain === apiUrl.hostname &&
      cookie.path === "/" &&
      cookie.secure === (apiUrl.protocol === "https:") &&
      unexpired
    );
  });
  if (matches.length !== 1) {
    return fail(
      "Better Auth storage state has no unique applicable session cookie"
    );
  }
  const [cookie] = matches;
  if (!cookie) {
    return fail("Better Auth storage state has no applicable session cookie");
  }
  return { name: cookie.name, value: cookie.value };
};

/**
 * Reads the explicitly configured external Playwright storage state and sends
 * only its applicable Better Auth session cookie to the exact configured API
 * session endpoint. No cookie, response payload, or upstream error survives
 * this boundary.
 */
export const verifyAuthenticatedSession = async (
  config: AuthenticatedLiveJobsConfig,
  dependencies: SessionVerifierDependencies = {}
): Promise<AuthenticatedSession> => {
  const apiUrl = new URL(config.apiUrl);
  const sessionUrl = new URL("/api/auth/get-session", apiUrl);
  let storageState: SessionVerifierJsonValue;
  try {
    storageState = await (
      dependencies.readStorageState ?? readExternalStorageState
    )(config.storageStatePath);
  } catch {
    return fail("Better Auth storage state is unavailable or invalid");
  }
  const cookie = readApplicableSessionCookie(
    storageState,
    apiUrl,
    (dependencies.now ?? (() => new Date()))()
  );

  let response: SessionResponse;
  try {
    response = await (dependencies.fetcher ?? defaultSessionFetcher)(
      sessionUrl.href,
      {
        headers: {
          Accept: "application/json",
          Cookie: `${cookie.name}=${cookie.value}`,
        },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs),
      }
    );
  } catch {
    return fail("Better Auth session verification request failed");
  }

  if (
    response.redirected ||
    response.status >= 300 ||
    response.status !== 200 ||
    response.url !== sessionUrl.href
  ) {
    return fail("Better Auth session endpoint returned an invalid response");
  }

  let payload: SessionVerifierJsonValue;
  try {
    payload = await response.json();
  } catch {
    return fail("Better Auth session endpoint returned an invalid response");
  }
  if (missingSessionResponseSchema.safeParse(payload).success) {
    return fail("Better Auth session is missing or expired");
  }
  const parsed = sessionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return fail("Better Auth session endpoint returned an invalid response");
  }
  const expiresAt = Date.parse(parsed.data.session.expiresAt);
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return fail("Better Auth session is missing or expired");
  }
  if (parsed.data.user.id !== config.expectedSubjectId) {
    return fail(
      "Better Auth session subject does not match the configured subject"
    );
  }
  return Object.freeze({ subjectId: parsed.data.user.id });
};

export const assertExpectedSessionSubject = (
  config: AuthenticatedLiveJobsConfig,
  session: AuthenticatedSession
): void => {
  if (session.subjectId !== config.expectedSubjectId) {
    throw new Error(
      "Better Auth subject does not match E2E_EXPECTED_SUBJECT_ID; no browser evidence or writes were attempted."
    );
  }
};

export const assertMutationSessionSubject = (
  config: MutationLiveJobsConfig,
  session: AuthenticatedSession
): void => {
  assertExpectedSessionSubject(config, session);
  if (session.subjectId !== config.testAccountId) {
    throw new Error(
      "Better Auth subject does not match E2E_TEST_ACCOUNT_ID; no browser writes were attempted."
    );
  }
};
