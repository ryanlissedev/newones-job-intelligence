import { describe, expect, it } from "bun:test";

import type { AuthenticatedLiveJobsConfig } from "./config";
import { verifyAuthenticatedSession } from "./session-verifier";
import type { SessionVerifierJsonValue } from "./session-verifier";

const fixedNow = new Date("2026-09-02T12:00:00.000Z");
const config = {
  apiUrl: "https://api.jobs.example",
  baseUrl: "https://jobs.example",
  canaryDigest: "a".repeat(64),
  canaryId: "00000000-0000-4000-8000-000000000001",
  expectedReleaseSha: "0".repeat(40),
  expectedSubjectId: "dedicated-test-account",
  localMode: false,
  query: "canary query",
  storageStatePath: "/private/tmp/external-e2e-storage-state.json",
  timeoutMs: 30_000,
} satisfies AuthenticatedLiveJobsConfig;

const sessionCookie = {
  domain: "api.jobs.example",
  expires: new Date("2030-01-01T00:00:00.000Z").getTime() / 1000,
  httpOnly: true,
  name: "__Secure-better-auth.session_token",
  path: "/",
  sameSite: "Lax",
  secure: true,
  value: "synthetic-session-cookie",
};

const validStorageState = () => ({
  cookies: [
    sessionCookie,
    {
      ...sessionCookie,
      name: "unrelated-cookie",
      value: "must-not-be-forwarded",
    },
  ],
  origins: [
    {
      localStorage: [{ name: "private", value: "must-not-be-forwarded" }],
      origin: "https://jobs.example",
    },
  ],
});

const validSessionPayload = () => ({
  session: {
    expiresAt: "2030-01-01T00:00:00.000Z",
    token: "must-not-be-retained",
  },
  user: {
    email: "must-not-be-retained@example.invalid",
    id: config.expectedSubjectId,
  },
});

const response = (
  payload: SessionVerifierJsonValue,
  overrides: Partial<{
    readonly redirected: boolean;
    readonly status: number;
    readonly url: string;
  }> = {}
) => ({
  json: () => Promise.resolve(payload),
  redirected: overrides.redirected ?? false,
  status: overrides.status ?? 200,
  url: overrides.url ?? "https://api.jobs.example/api/auth/get-session",
});

describe("live jobs Better Auth session verifier", () => {
  it("sends only the applicable cookie to the exact API session endpoint", async () => {
    let requestInput = "";
    let requestInit: RequestInit | undefined;
    const session = await verifyAuthenticatedSession(config, {
      fetcher: (input, init) => {
        requestInput = input;
        requestInit = init;
        return Promise.resolve(response(validSessionPayload()));
      },
      now: () => fixedNow,
      readStorageState: (path) => {
        expect(path).toBe(config.storageStatePath);
        return Promise.resolve(validStorageState());
      },
    });

    expect(session).toEqual({ subjectId: config.expectedSubjectId });
    expect(requestInput).toBe("https://api.jobs.example/api/auth/get-session");
    expect(requestInit?.method).toBe("GET");
    expect(requestInit?.redirect).toBe("manual");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Cookie")).toBe(
      "__Secure-better-auth.session_token=synthetic-session-cookie"
    );
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("Cookie")).not.toContain("unrelated-cookie");
    expect(headers.get("Cookie")).not.toContain("must-not-be-forwarded");
  });

  it("uses the non-Secure cookie name only for an exact HTTP API host", async () => {
    const localConfig = {
      ...config,
      apiUrl: "http://127.0.0.1:3000",
      localMode: true,
    };
    let requestInit: RequestInit | undefined;

    await verifyAuthenticatedSession(localConfig, {
      fetcher: (_input, init) => {
        requestInit = init;
        return Promise.resolve(
          response(validSessionPayload(), {
            url: "http://127.0.0.1:3000/api/auth/get-session",
          })
        );
      },
      now: () => fixedNow,
      readStorageState: () =>
        Promise.resolve({
          cookies: [
            {
              ...sessionCookie,
              domain: "127.0.0.1",
              name: "better-auth.session_token",
              secure: false,
            },
          ],
        }),
    });

    expect(new Headers(requestInit?.headers).get("Cookie")).toBe(
      "better-auth.session_token=synthetic-session-cookie"
    );
  });

  it("rejects cookies for the wrong origin, path, security mode, or expiry", async () => {
    const invalidCookies = [
      { ...sessionCookie, domain: "jobs.example" },
      { ...sessionCookie, domain: ".jobs.example" },
      { ...sessionCookie, path: "/another-path" },
      { ...sessionCookie, secure: false },
      { ...sessionCookie, expires: fixedNow.getTime() / 1000 },
    ];

    await Promise.all(
      invalidCookies.map(async (cookie) => {
        let fetchCalls = 0;
        await expect(
          verifyAuthenticatedSession(config, {
            fetcher: () => {
              fetchCalls += 1;
              return Promise.resolve(response(validSessionPayload()));
            },
            now: () => fixedNow,
            readStorageState: () => Promise.resolve({ cookies: [cookie] }),
          })
        ).rejects.toThrow(/no unique applicable session cookie/u);
        expect(fetchCalls).toBe(0);
      })
    );
  });

  it("rejects ambiguous cookies before making a request", async () => {
    let fetchCalls = 0;
    await expect(
      verifyAuthenticatedSession(config, {
        fetcher: () => {
          fetchCalls += 1;
          return Promise.resolve(response(validSessionPayload()));
        },
        now: () => fixedNow,
        readStorageState: () =>
          Promise.resolve({ cookies: [sessionCookie, { ...sessionCookie }] }),
      })
    ).rejects.toThrow(/session cookie/u);
    expect(fetchCalls).toBe(0);
  });

  it("rejects every non-cookie-octet value before making a request", async () => {
    const invalidCookieValues = [
      "contains space",
      'contains"quote',
      "contains,comma",
      "contains\\backslash",
      "contains-é",
      "unsafe;injected=value",
      "unsafe\nheader",
    ];

    await Promise.all(
      invalidCookieValues.map(async (cookieValue) => {
        let fetchCalls = 0;
        await expect(
          verifyAuthenticatedSession(config, {
            fetcher: () => {
              fetchCalls += 1;
              return Promise.resolve(response(validSessionPayload()));
            },
            now: () => fixedNow,
            readStorageState: () =>
              Promise.resolve({
                cookies: [{ ...sessionCookie, value: cookieValue }],
              }),
          })
        ).rejects.toThrow(/storage state/u);
        expect(fetchCalls).toBe(0);
      })
    );
  });

  it("rejects redirects and responses from any other origin or path", async () => {
    const invalidResponses = [
      response(validSessionPayload(), { status: 302 }),
      response(validSessionPayload(), { redirected: true }),
      response(validSessionPayload(), {
        url: "https://other.example/api/auth/get-session",
      }),
      response(validSessionPayload(), {
        url: "https://api.jobs.example/api/auth/other",
      }),
    ];

    await Promise.all(
      invalidResponses.map(async (invalidResponse) => {
        await expect(
          verifyAuthenticatedSession(config, {
            fetcher: () => Promise.resolve(invalidResponse),
            now: () => fixedNow,
            readStorageState: () => Promise.resolve(validStorageState()),
          })
        ).rejects.toThrow(/invalid response/u);
      })
    );
  });

  it("fails closed for malformed or unreadable storage state without leaking details", async () => {
    const unsafeDetail = "synthetic-cookie-secret-must-not-leak";
    const failures = [
      () => Promise.resolve({ cookies: "not-an-array" }),
      () => Promise.reject(new Error(unsafeDetail)),
    ];

    await Promise.all(
      failures.map(async (readStorageState) => {
        try {
          await verifyAuthenticatedSession(config, {
            now: () => fixedNow,
            readStorageState,
          });
          throw new Error("expected verifier failure");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (error instanceof Error) {
            expect(error.message).toContain("storage state");
            expect(error.message).not.toContain(unsafeDetail);
          }
        }
      })
    );
  });

  it("rejects malformed session responses without retaining raw payloads", async () => {
    const unsafeDetail = "raw-session-secret-must-not-leak";
    try {
      await verifyAuthenticatedSession(config, {
        fetcher: () => Promise.resolve(response({ unexpected: unsafeDetail })),
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      });
      throw new Error("expected verifier failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("invalid response");
        expect(error.message).not.toContain(unsafeDetail);
      }
    }
  });

  it("discards upstream request errors without exposing their details", async () => {
    const unsafeDetail = "upstream-cookie-detail-must-not-leak";
    try {
      await verifyAuthenticatedSession(config, {
        fetcher: () => Promise.reject(new Error(unsafeDetail)),
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      });
      throw new Error("expected verifier failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("verification request failed");
        expect(error.message).not.toContain(unsafeDetail);
      }
    }
  });

  it("rejects missing and expired sessions", async () => {
    const expired = validSessionPayload();
    expired.session.expiresAt = fixedNow.toISOString();

    await Promise.all(
      [null, expired].map(async (payload) => {
        await expect(
          verifyAuthenticatedSession(config, {
            fetcher: () => Promise.resolve(response(payload)),
            now: () => fixedNow,
            readStorageState: () => Promise.resolve(validStorageState()),
          })
        ).rejects.toThrow(/missing or expired/u);
      })
    );
  });

  it("rejects a server-derived subject that does not exactly match config", async () => {
    const payload = validSessionPayload();
    payload.user.id = "different-account";

    await expect(
      verifyAuthenticatedSession(config, {
        fetcher: () => Promise.resolve(response(payload)),
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      })
    ).rejects.toThrow(/configured subject/u);
  });

  it("rejects a server-derived subject with leading whitespace", async () => {
    const payload = validSessionPayload();
    payload.user.id = ` ${config.expectedSubjectId}`;
    const fetchedUrls: string[] = [];

    await expect(
      verifyAuthenticatedSession(config, {
        fetcher: (input) => {
          fetchedUrls.push(input);
          return Promise.resolve(response(payload));
        },
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      })
    ).rejects.toThrow(/configured subject/u);
    expect(fetchedUrls).toEqual([
      "https://api.jobs.example/api/auth/get-session",
    ]);
  });

  it("rejects a server-derived subject with trailing whitespace", async () => {
    const payload = validSessionPayload();
    payload.user.id = `${config.expectedSubjectId} `;
    const fetchedUrls: string[] = [];

    await expect(
      verifyAuthenticatedSession(config, {
        fetcher: (input) => {
          fetchedUrls.push(input);
          return Promise.resolve(response(payload));
        },
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      })
    ).rejects.toThrow(/configured subject/u);
    expect(fetchedUrls).toEqual([
      "https://api.jobs.example/api/auth/get-session",
    ]);
  });

  it("rejects a server-derived subject containing only whitespace", async () => {
    const payload = validSessionPayload();
    payload.user.id = " ";
    const fetchedUrls: string[] = [];

    await expect(
      verifyAuthenticatedSession(config, {
        fetcher: (input) => {
          fetchedUrls.push(input);
          return Promise.resolve(response(payload));
        },
        now: () => fixedNow,
        readStorageState: () => Promise.resolve(validStorageState()),
      })
    ).rejects.toThrow(/configured subject/u);
    expect(fetchedUrls).toEqual([
      "https://api.jobs.example/api/auth/get-session",
    ]);
  });
});
