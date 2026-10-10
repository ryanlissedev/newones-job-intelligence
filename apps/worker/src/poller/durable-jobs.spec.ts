import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";
import { PersistedQueueError } from "effect/unstable/persistence/PersistedQueue";

import { WorkerDependencyFault } from "../effect/faults";
import {
  bronIngestJobSchema,
  offerBronIngestJob,
  resolveDurableBronnen,
  runDurableBronJobConsumer,
} from "./durable-jobs";
import type { BronIngestJob } from "./durable-jobs";

const STRIIVE_JOB: BronIngestJob = {
  bronId: "00000000-0000-4000-8000-000000000008",
  bronSlug: "striive",
  scrapeRunId: "11111111-2222-4333-8444-555555555555",
};

describe("resolveDurableBronnen", () => {
  it("treats unset and blank as fully inline (rollback default)", () => {
    expect(resolveDurableBronnen().size).toBe(0);
    expect(resolveDurableBronnen("").size).toBe(0);
    expect(resolveDurableBronnen("   ").size).toBe(0);
  });

  it("parses a trimmed comma-separated slug list", () => {
    expect(resolveDurableBronnen("striive")).toEqual(new Set(["striive"]));
    expect(resolveDurableBronnen(" striive , bluetrail ")).toEqual(
      new Set(["striive", "bluetrail"])
    );
  });

  it("accepts the CTP-630 JSON-LD cohort slugs", () => {
    expect(resolveDurableBronnen("bluetrail,hero,pro-act")).toEqual(
      new Set(["bluetrail", "hero", "pro-act"])
    );
  });

  it("fails closed on an unknown slug instead of silently routing", () => {
    expect(() => resolveDurableBronnen("strrive")).toThrow(
      /unknown bron slug/iu
    );
  });
});

describe("bronIngestJobSchema", () => {
  it("accepts a well-formed Striive job", () => {
    const decoded = Schema.decodeUnknownSync(bronIngestJobSchema)(STRIIVE_JOB);
    expect(decoded).toEqual(STRIIVE_JOB);
  });

  it("rejects non-UUID identities (queue rows must name a scrape_run)", () => {
    expect(() =>
      Schema.decodeUnknownSync(bronIngestJobSchema)({
        ...STRIIVE_JOB,
        scrapeRunId: "not-a-uuid",
      })
    ).toThrow();
  });
});

describe("offerBronIngestJob", () => {
  it("uses the scrapeRunId as the queue identity (stable job identity)", async () => {
    let offeredId: string | undefined;
    let offeredValue: BronIngestJob | undefined;
    const queue = {
      offer: (value: BronIngestJob, options?: { id?: string }) => {
        offeredId = options?.id;
        offeredValue = value;
        return Effect.succeed(options?.id ?? "");
      },
    };
    const id = await offerBronIngestJob(queue, STRIIVE_JOB);
    expect(id).toBe(STRIIVE_JOB.scrapeRunId);
    expect(offeredId).toBe(STRIIVE_JOB.scrapeRunId);
    expect(offeredValue).toEqual(STRIIVE_JOB);
  });

  it("maps a store failure to WorkerDependencyFault, not a raw defect", async () => {
    const queue = {
      offer: () =>
        // SAFETY: test double — the consumer only needs an Effect-typed return.
        Effect.fail(
          new PersistedQueueError({ message: "insert failed" })
        ) as never,
    };
    await expect(offerBronIngestJob(queue, STRIIVE_JOB)).rejects.toBeInstanceOf(
      WorkerDependencyFault
    );
  });
});

describe("runDurableBronJobConsumer", () => {
  it("hands each taken job to processJob with its attempt count", async () => {
    const seen: { attempts: number; scrapeRunId: string }[] = [];
    const gate = Promise.withResolvers<null>();
    let takes = 0;
    const queue = {
      take: (
        f: (
          job: BronIngestJob,
          metadata: { attempts: number; id: string }
        ) => Effect.Effect<unknown, unknown, unknown>
      ) => {
        takes += 1;
        // Take once, then park: the consumer must not spin on an empty queue.
        if (takes > 1) {
          return Effect.never;
        }
        // SAFETY: test double — the consumer only needs an Effect-typed return.
        return f(STRIIVE_JOB, {
          attempts: 2,
          id: STRIIVE_JOB.scrapeRunId,
        }) as never;
      },
    };
    const controller = new AbortController();
    const consumer = runDurableBronJobConsumer({
      maxAttempts: 5,
      processJob: (job, attempts) => {
        seen.push({ attempts, scrapeRunId: job.scrapeRunId });
        gate.resolve(null);
        return Promise.resolve();
      },
      queue,
      signal: controller.signal,
    });
    await gate.promise;
    controller.abort();
    await consumer;
    expect(seen).toEqual([
      { attempts: 2, scrapeRunId: STRIIVE_JOB.scrapeRunId },
    ]);
    expect(takes).toBeGreaterThan(0);
  });

  it("reports a failed take through onJobError and keeps consuming", async () => {
    const errors: Error[] = [];
    const gate = Promise.withResolvers<null>();
    let takes = 0;
    const queue = {
      take: () => {
        takes += 1;
        if (takes === 1) {
          // SAFETY: test double — the consumer only needs an Effect-typed return.
          return Effect.fail(
            new PersistedQueueError({ message: "claim blew up" })
          ) as never;
        }
        return Effect.never;
      },
    };
    const controller = new AbortController();
    const consumer = runDurableBronJobConsumer({
      maxAttempts: 5,
      onJobError: (error) => {
        errors.push(error);
        gate.resolve(null);
      },
      processJob: () => Promise.resolve(),
      queue,
      signal: controller.signal,
    });
    await gate.promise;
    controller.abort();
    await consumer;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("claim blew up");
    expect(takes).toBeGreaterThanOrEqual(2);
  });

  it("stops taking when the shutdown signal aborts", async () => {
    const controller = new AbortController();
    let takes = 0;
    const queue = {
      take: () => {
        takes += 1;
        return Effect.never;
      },
    };
    const consumer = runDurableBronJobConsumer({
      maxAttempts: 5,
      processJob: () => Promise.resolve(),
      queue,
      signal: controller.signal,
    });
    controller.abort();
    await consumer;
    expect(takes).toBeLessThanOrEqual(1);
  });
});
