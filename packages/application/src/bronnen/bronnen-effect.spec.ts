import { describe, expect, it } from "bun:test";

import {
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
} from "@ji/connectors";
import { Effect } from "effect";

import {
  runUseCasePromise,
  UseCaseCancelFault,
  UseCaseNotFoundFault,
} from "../effect";
import {
  createBronEffect,
  runCreateBron,
  runExecuteBronRun,
  runListPublicBronnen,
} from "./index";
import { createBron, listPublicBronnen } from "./register";
import type { BronPersistence, BronRegisterRecord } from "./register";

const tendernedBron = () => ({
  bronId: "bron-effect-fixed",
  categorie: "overheidsportaal",
  crawlDelayMs: 1000,
  interval: "*/15 * * * *",
  loginVereist: false,
  mappingRef: "fixtures/connectors/tenderned/mapping.json",
  method: "json-api" as const,
  naam: "TenderNed",
  rateLimitPerMinute: 30,
  retentionDays: 90,
  secretRef: null,
  status: "deferred" as const,
  voorwaardenStatus: "toegestaan" as const,
});

describe("bronnen Effect dual-path", () => {
  it("createBronEffect matches native createBron", async () => {
    const input = tendernedBron();
    const native = createBron(input);
    const viaEffect = await runCreateBron(input);
    expect(viaEffect).toEqual(native);
    expect(Effect.runSync(createBronEffect(input))).toEqual(native);
  });

  it("listPublicBronnenEffect matches native list", async () => {
    const record: BronRegisterRecord = {
      ...tendernedBron(),
      actief: false,
      lastRun: null,
    };
    const persistence: BronPersistence = {
      activate: () => Promise.reject(new Error("unused")),
      create: (created) => Promise.resolve(created),
      findById: () => Promise.resolve(record),
      list: () => Promise.resolve([record]),
    };
    expect(await runListPublicBronnen(persistence)).toEqual(
      await listPublicBronnen(persistence)
    );
  });

  it("executeBronRunEffect rejects missing bron as UseCaseNotFoundFault", async () => {
    const persistence: BronPersistence = {
      activate: () => Promise.reject(new Error("unused")),
      create: (created) => Promise.resolve(created),
      findById: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    };
    await expect(
      runExecuteBronRun(persistence, {
        bronId: "missing",
        bronSlug: "tenderned",
        // SAFETY: executeBronRun fails on missing bron before invoking the connector.
        connector: {
          crawl: () => {
            throw new Error("should not crawl");
          },
        } as never,
        objectStore: new InMemoryObjectStore(),
        observationRecorder: new InMemoryObservationRecorder(),
        runLifecycleStore: new InMemoryRunLifecycleStore(),
        scrapeRunId: "run-1",
      })
    ).rejects.toBeInstanceOf(UseCaseNotFoundFault);
  });

  it("runUseCasePromise cancels on abort", async () => {
    const controller = new AbortController();
    const pending = runUseCasePromise(Effect.never, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UseCaseCancelFault);
  });
});
