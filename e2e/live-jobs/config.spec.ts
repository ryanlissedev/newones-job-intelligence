import { describe, expect, it } from "bun:test";

import {
  assertAnonymousLiveRun,
  assertAuthenticatedLiveRun,
  assertMutationLiveRun,
  assertReadOnlyLiveRun,
  buildNamespacedQuery,
  readLiveJobsConfig,
} from "./config";
import type { LiveJobsEnvironment } from "./config";
import { preflightLiveJobsCleanup } from "./mutation-cleanup";

const remoteEnvironment = {
  E2E_API_URL: "https://api.jobs.example",
  E2E_BASE_URL: "https://jobs.example",
  E2E_CANARY_DIGEST:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  E2E_CANARY_ID: "00000000-0000-4000-8000-000000000001",
  E2E_EXPECTED_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
  E2E_EXPECTED_SUBJECT_ID: "dedicated-test-account",
  E2E_QUERY: "platform engineer",
} satisfies LiveJobsEnvironment;

const localEnvironment = {
  E2E_API_URL: "http://localhost:3000",
  E2E_BASE_URL: "http://localhost:3001",
  E2E_CANARY_DIGEST:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  E2E_CANARY_ID: "00000000-0000-4000-8000-000000000001",
  E2E_EXPECTED_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
  E2E_EXPECTED_SUBJECT_ID: "dedicated-test-account",
  E2E_LOCAL_MODE: "1",
  E2E_QUERY: "platform engineer",
} satisfies LiveJobsEnvironment;

describe("live jobs E2E guardrails", () => {
  it("requires explicit read-only opt-in", () => {
    expect(() => assertReadOnlyLiveRun(remoteEnvironment)).toThrow(
      /E2E_LIVE=1/u
    );
  });

  it("requires an exact 40-character expected release SHA", () => {
    expect(() =>
      assertReadOnlyLiveRun({
        ...remoteEnvironment,
        E2E_EXPECTED_RELEASE_SHA: "not-a-sha",
        E2E_LIVE: "1",
      })
    ).toThrow(/E2E_EXPECTED_RELEASE_SHA/u);
  });

  it("requires a real storage state for authenticated read verification", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
      })
    ).toThrow(/E2E_STORAGE_STATE/u);
  });

  it("requires explicit canary data for authenticated evidence", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      })
    ).toThrow(/E2E_DATA_MODE=canary/u);
  });

  it("requires an immutable canary UUID even when a query is present", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_CANARY_ID: "listed-first-but-not-a-canary",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      })
    ).toThrow(/E2E_CANARY_ID/u);
  });

  it("refuses an authenticated run with no immutable canary ID", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_CANARY_ID: undefined,
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      })
    ).toThrow(/E2E_CANARY_ID/u);
  });

  it("requires a pinned canonical canary digest for authenticated evidence", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_CANARY_DIGEST: undefined,
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      })
    ).toThrow(/E2E_CANARY_DIGEST/u);
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_CANARY_DIGEST:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      })
    ).toThrow(/lowercase SHA-256/u);
  });

  it("keeps storage state outside the working tree", () => {
    expect(() =>
      assertAuthenticatedLiveRun({
        ...remoteEnvironment,
        E2E_AUTH_MODE: "session",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: `${process.cwd()}/e2e-storage-state.json`,
      })
    ).toThrow(/outside the working tree/u);
  });

  it("keeps anonymous verification deliberately session-free", () => {
    expect(() => {
      const { E2E_QUERY: _query, ...anonymousEnvironment } = remoteEnvironment;
      return assertAnonymousLiveRun({
        ...anonymousEnvironment,
        E2E_AUTH_MODE: "anonymous",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/state.json",
      });
    }).toThrow(/genuinely unauthenticated/u);
  });

  it("does not require a search query for the anonymous protected-state proof", () => {
    const { E2E_QUERY: _query, ...anonymousEnvironment } = remoteEnvironment;

    expect(
      assertAnonymousLiveRun({
        ...anonymousEnvironment,
        E2E_AUTH_MODE: "anonymous",
        E2E_LIVE: "1",
      }).query
    ).toBe("");
  });

  it("rejects fixtures even in explicit local mode", () => {
    expect(() =>
      readLiveJobsConfig({
        ...localEnvironment,
        NEXT_PUBLIC_USE_FIXTURES: "true",
      })
    ).toThrow(/fixture or mock/u);
  });

  it("requires explicit local mode for test hosts", () => {
    expect(() =>
      readLiveJobsConfig({
        ...localEnvironment,
        E2E_LOCAL_MODE: undefined,
      })
    ).toThrow(/test host/u);
  });

  it("only permits local endpoints in local mode", () => {
    expect(() =>
      readLiveJobsConfig({
        ...remoteEnvironment,
        E2E_LOCAL_MODE: "1",
      })
    ).toThrow(/localhost/u);
  });

  it("requires HTTPS outside local mode", () => {
    expect(() =>
      readLiveJobsConfig({
        ...remoteEnvironment,
        E2E_API_URL: "http://api.jobs.example.com",
      })
    ).toThrow(/HTTPS/u);
  });

  it("builds a safe namespaced Boolean query", () => {
    expect(buildNamespacedQuery("e2e-20260902-read", "Azure OR React")).toBe(
      '("e2e-20260902-read" OR (Azure OR React))'
    );
  });

  it("requires every mutation safeguard and returns a complete configuration", () => {
    const environment = {
      ...localEnvironment,
      E2E_ALLOW_WRITES: "1",
      E2E_AUTH_MODE: "session",
      E2E_CLEANUP_TOKEN: "test-token-from-environment",
      E2E_CLEANUP_URL: "http://localhost:3000/e2e/cleanup",
      E2E_DATA_MODE: "canary",
      E2E_LIVE: "1",
      E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      E2E_TEST_ACCOUNT_ID: "dedicated-test-account",
      E2E_TEST_ENV: "isolated",
      E2E_TEST_NAMESPACE: "e2e-20260902-write",
    } satisfies LiveJobsEnvironment;

    const config = assertMutationLiveRun(environment);

    expect(config.cleanupUrl).toBe("http://localhost:3000/e2e/cleanup");
    expect(config.testNamespace).toBe("e2e-20260902-write");
  });

  it("rejects a mutation account that differs from the expected session subject", () => {
    expect(() =>
      assertMutationLiveRun({
        ...localEnvironment,
        E2E_ALLOW_WRITES: "1",
        E2E_AUTH_MODE: "session",
        E2E_CLEANUP_TOKEN: "test-token-from-environment",
        E2E_CLEANUP_URL: "http://localhost:3000/e2e/cleanup",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
        E2E_TEST_ACCOUNT_ID: "other-test-account",
        E2E_TEST_ENV: "isolated",
        E2E_TEST_NAMESPACE: "e2e-20260902-write",
      })
    ).toThrow(/E2E_EXPECTED_SUBJECT_ID/u);
  });

  it("captures a baseline-preserving cleanup scope before browser writes", async () => {
    const config = assertMutationLiveRun({
      ...localEnvironment,
      E2E_ALLOW_WRITES: "1",
      E2E_AUTH_MODE: "session",
      E2E_CLEANUP_TOKEN: "test-token-from-environment",
      E2E_CLEANUP_URL: "http://localhost:3000/e2e/cleanup",
      E2E_DATA_MODE: "canary",
      E2E_LIVE: "1",
      E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      E2E_TEST_ACCOUNT_ID: "dedicated-test-account",
      E2E_TEST_ENV: "isolated",
      E2E_TEST_NAMESPACE: "e2e-20260902-write",
    });

    const baseline = await preflightLiveJobsCleanup(config, (input, init) => {
      expect(input).toBe(config.cleanupUrl);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBe(
        JSON.stringify({
          action: "capture-baseline",
          scope: {
            accountId: config.testAccountId,
            canaryId: config.canaryId,
            namespace: config.testNamespace,
          },
        })
      );
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            baselineToken: "safe-baseline-token",
            preservedExistingState: true,
          }),
        status: 200,
        url: config.cleanupUrl,
      });
    });
    expect(baseline).toEqual({ token: "safe-baseline-token" });
  });

  it("blocks the mutation runner when cleanup preflight fails", async () => {
    const config = assertMutationLiveRun({
      ...localEnvironment,
      E2E_ALLOW_WRITES: "1",
      E2E_AUTH_MODE: "session",
      E2E_CLEANUP_TOKEN: "test-token-from-environment",
      E2E_CLEANUP_URL: "http://localhost:3000/e2e/cleanup",
      E2E_DATA_MODE: "canary",
      E2E_LIVE: "1",
      E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
      E2E_TEST_ACCOUNT_ID: "dedicated-test-account",
      E2E_TEST_ENV: "isolated",
      E2E_TEST_NAMESPACE: "e2e-20260902-write",
    });

    await expect(
      preflightLiveJobsCleanup(config, () =>
        Promise.resolve({
          json: () => Promise.resolve(null),
          status: 503,
          url: config.cleanupUrl,
        })
      )
    ).rejects.toThrow(/no browser writes were attempted/u);
  });

  it("rejects mutation mode before it can use the default recruiter subject", () => {
    expect(() =>
      assertMutationLiveRun({
        ...localEnvironment,
        E2E_ALLOW_WRITES: "1",
        E2E_AUTH_MODE: "session",
        E2E_DATA_MODE: "canary",
        E2E_LIVE: "1",
        E2E_STORAGE_STATE: "/private/tmp/e2e-storage-state.json",
        E2E_TEST_ACCOUNT_ID: "web-recruiter",
        E2E_TEST_ENV: "isolated",
      })
    ).toThrow(/dedicated test account/u);
  });
});
