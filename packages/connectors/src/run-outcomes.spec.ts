import { describe, expect, it } from "bun:test";

import type { Connector, ConnectorFetchResult } from "./contract";
import { mergeRunMetrics } from "./contract";
import {
  AuthFault,
  RateLimitFault,
  Server5xxFault,
  TransientNetworkFault,
} from "./effect-runtime/faults";
import { HttpTimeoutError } from "./http-timeout";
import {
  cloudflareChallengeError,
  HttpStatusError,
} from "./json-ld/live-fetch";
import { CrawlDelayLimiter } from "./limiter";
import { InMemoryObjectStore } from "./object-store";
import { InMemoryObservationRecorder } from "./observation-recorder";
import { runConnector } from "./run";
import { InMemoryRunLifecycleStore } from "./run-lifecycle";
import type { RunFailureInput } from "./run-lifecycle";
import { classifyRunFailure, mergeOutcomeCounts } from "./run-outcomes";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

class RecordingRunStore extends InMemoryRunLifecycleStore {
  readonly failures: RunFailureInput[] = [];

  override fail(input: RunFailureInput): Promise<void> {
    this.failures.push(input);
    return super.fail(input);
  }
}

const fetchedResult = (bronReferentie: string): ConnectorFetchResult => ({
  body: new TextEncoder().encode(JSON.stringify({ id: bronReferentie })),
  bronReferentie,
  contentHash:
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  contentType: "json",
  status: "fetched",
});

/** One listing page whose items each map to a scripted fetch outcome. */
const scriptedConnector = (
  bronId: string,
  script: Record<string, () => Promise<ConnectorFetchResult | null>>
): Connector => ({
  bronId,
  discover: () =>
    Promise.resolve({
      checkpoint: { page: 1 },
      hasMore: false,
      items: Object.keys(script).map((bronReferentie) => ({
        bronReferentie,
        contentHash: `listing-${bronReferentie}`,
      })),
    }),
  fetch: (item) => {
    const step = script[item.bronReferentie];
    if (step === undefined) {
      throw new Error(`unscripted item ${item.bronReferentie}`);
    }
    return step();
  },
});

const runWith = (connector: Connector, store: InMemoryRunLifecycleStore) =>
  runConnector({
    bronId: connector.bronId,
    bronSlug: "outcomes",
    connector,
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "poll",
    runLifecycleStore: store,
    scrapeRunId: `run-${connector.bronId}`,
  });

describe("classifyRunFailure", () => {
  it("separates blocks, rate limits, timeouts and server errors", () => {
    expect(
      classifyRunFailure(
        cloudflareChallengeError({
          cookieEnvVar: null,
          slug: "werkzoeken",
          url: "https://example.test/",
        })
      )
    ).toBe("blocked");
    expect(classifyRunFailure(new HttpTimeoutError(30_000))).toBe("timeout");
    expect(
      classifyRunFailure(
        new HttpStatusError({ slug: "s", status: 429, url: "https://x.test" })
      )
    ).toBe("rate_limited");
    expect(
      classifyRunFailure(
        new HttpStatusError({ slug: "s", status: 403, url: "https://x.test" })
      )
    ).toBe("blocked");
    expect(
      classifyRunFailure(
        new HttpStatusError({ slug: "s", status: 503, url: "https://x.test" })
      )
    ).toBe("http_5xx");
    expect(
      classifyRunFailure(
        new HttpStatusError({ slug: "s", status: 410, url: "https://x.test" })
      )
    ).toBe("http_4xx");
  });

  it("classifies typed read faults", () => {
    expect(
      classifyRunFailure(
        new RateLimitFault({ message: "slow", retryAfterMs: null, status: 429 })
      )
    ).toBe("rate_limited");
    expect(
      classifyRunFailure(new Server5xxFault({ message: "boom", status: 503 }))
    ).toBe("http_5xx");
    expect(
      classifyRunFailure(new TransientNetworkFault({ message: "reset" }))
    ).toBe("network");
    expect(classifyRunFailure(new AuthFault({ message: "denied" }))).toBe(
      "blocked"
    );
  });

  it("walks the cause chain and falls back to internal", () => {
    const wrapped = new Error("fetch failed", {
      cause: new HttpStatusError({
        slug: "s",
        status: 502,
        url: "https://x.test",
      }),
    });
    expect(classifyRunFailure(wrapped)).toBe("http_5xx");
    expect(classifyRunFailure(new TypeError("undefined is not"))).toBe(
      "internal"
    );
    expect(classifyRunFailure("not an error")).toBe("internal");
  });
});

describe("outcome counts", () => {
  it("merges counters and drops zeroes", () => {
    expect(
      mergeOutcomeCounts(
        { skipped_known: 2 },
        { rejected_gone: 1, skipped_known: 3 }
      )
    ).toEqual({ rejected_gone: 1, skipped_known: 5 });
    expect(mergeOutcomeCounts(undefined, {})).toEqual({});
  });

  it("keeps outcomes when run metrics merge", () => {
    const base = {
      changed: 0,
      error: 0,
      found: 1,
      new: 0,
      rejected: 0,
      unchanged: 0,
    };
    expect(
      mergeRunMetrics(
        { ...base, outcomes: { skipped_known: 1 } },
        { ...base, outcomes: { skipped_known: 2 } }
      ).outcomes
    ).toEqual({ skipped_known: 3 });
    expect(mergeRunMetrics(base, base).outcomes).toBeUndefined();
  });
});

describe("runConnector outcome accounting", () => {
  it("counts skipped fetches and rejections by kind", async () => {
    const store = new RecordingRunStore();
    const connector = scriptedConnector("bron-outcomes", {
      "A-1": () => Promise.resolve(null),
      "A-2": () => Promise.resolve(null),
      "A-3": () =>
        Promise.resolve({
          bronReferentie: "A-3",
          kind: "gone" as const,
          reason: "detail page returned 404 — removed at source",
          status: "rejected" as const,
        }),
      "A-4": () =>
        Promise.resolve({
          bronReferentie: "A-4",
          kind: "no_structured_data" as const,
          reason: "no JobPosting JSON-LD found on detail page",
          status: "rejected" as const,
        }),
      "A-5": () =>
        Promise.resolve({
          bronReferentie: "A-5",
          reason: "listing payload missing url",
          status: "rejected" as const,
        }),
      "A-6": () => Promise.resolve(fetchedResult("A-6")),
    });

    const result = await runWith(connector, store);

    expect(result.metrics).toMatchObject({
      found: 6,
      new: 1,
      outcomes: {
        rejected_gone: 1,
        rejected_invalid: 1,
        rejected_no_structured_data: 1,
        skipped_known: 2,
      },
      rejected: 3,
    });
    const persisted = await store.load({
      bronId: "bron-outcomes",
      scrapeRunId: "run-bron-outcomes",
    });
    expect(persisted?.metrics.outcomes).toEqual(result.metrics.outcomes);
  });

  it("records the failure kind when a run fails", async () => {
    const store = new RecordingRunStore();
    const connector = scriptedConnector("bron-blocked", {
      "B-1": () =>
        Promise.reject(
          cloudflareChallengeError({
            cookieEnvVar: null,
            slug: "blocked",
            url: "https://example.test/vacature/1",
          })
        ),
    });

    await expect(runWith(connector, store)).rejects.toThrow(
      "Connector fetch failed"
    );
    expect(store.failures.map((failure) => failure.failureKind)).toEqual([
      "blocked",
    ]);
  });
});
