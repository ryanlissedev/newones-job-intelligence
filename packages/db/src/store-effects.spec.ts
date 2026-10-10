import { describe, expect, it } from "bun:test";

import type { AanvraagRecord, AanvraagStore } from "@ji/application/registry";
import type { KnownHashStore } from "@ji/connectors";
import { Effect } from "effect";

import { DbStoreCancelFault, DbStoreDependencyFault } from "./effect";
import {
  aanvraagGetByIdEffect,
  knownHashGetEffect,
  wrapAanvraagStoreEffect,
  wrapKnownHashStoreEffect,
} from "./store-effects";

const FAKE_AANVRAAG: AanvraagRecord = {
  beschrijving: "Interim opdracht",
  bronId: "bron-1",
  bronReferentie: "ref-1",
  id: "aanvraag-1",
  rawPayloadRef: "raw-1",
  scrapeRunId: "run-1",
  status: "open",
  titel: "Interim professional",
  versies: [],
};

const createFakeAanvraagStore = (): AanvraagStore => ({
  getById: (id) => {
    if (id === "boom") {
      return Promise.reject(new Error("connection dropped"));
    }
    if (id === "missing") {
      return Promise.reject(new Error("aanvraag not found"));
    }
    return Promise.resolve(id === FAKE_AANVRAAG.id ? FAKE_AANVRAAG : null);
  },
  getByIds: (ids) =>
    Promise.resolve(ids.includes(FAKE_AANVRAAG.id) ? [FAKE_AANVRAAG] : []),
  listVersies: () => Promise.resolve([]),
});

const createNeverResolvingAanvraagStore = (): AanvraagStore => ({
  // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
  getById: () => new Promise(() => {}),
  // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
  getByIds: () => new Promise(() => {}),
  // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
  listVersies: () => new Promise(() => {}),
});

const createFakeKnownHashStore = (): KnownHashStore => ({
  get: () => Promise.resolve("known-hash"),
});

describe("wrapAanvraagStoreEffect", () => {
  it("delegates to the native store on success", async () => {
    const wrapped = wrapAanvraagStoreEffect(createFakeAanvraagStore());

    await expect(wrapped.getById(FAKE_AANVRAAG.id)).resolves.toEqual(
      FAKE_AANVRAAG
    );
    await expect(wrapped.getById("nope")).resolves.toBeNull();
  });

  it("maps an inner Error to a not_found DbStoreFault", async () => {
    const wrapped = wrapAanvraagStoreEffect(createFakeAanvraagStore());

    await expect(wrapped.getById("missing")).rejects.toMatchObject({
      _tag: "not_found",
    });
  });

  it("maps an unrecognised inner Error to a dependency DbStoreFault", async () => {
    const wrapped = wrapAanvraagStoreEffect(createFakeAanvraagStore());

    const failure = wrapped.getById("boom");
    await expect(failure).rejects.toBeInstanceOf(DbStoreDependencyFault);
    await expect(failure).rejects.toMatchObject({ _tag: "dependency" });
  });

  it("maps an aborted signal to a cancel DbStoreFault", async () => {
    const controller = new AbortController();
    const wrapped = wrapAanvraagStoreEffect(
      createNeverResolvingAanvraagStore(),
      { signal: controller.signal }
    );

    const pending = wrapped.getById(FAKE_AANVRAAG.id);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DbStoreCancelFault);
    await expect(pending).rejects.toMatchObject({ _tag: "cancel" });
  });
});

describe("wrapKnownHashStoreEffect", () => {
  it("delegates to the native store on success", async () => {
    const wrapped = wrapKnownHashStoreEffect(createFakeKnownHashStore());

    await expect(wrapped.get("bron-1", "ref-1")).resolves.toBe("known-hash");
  });
});

describe("representative Effect helpers", () => {
  it("aanvraagGetByIdEffect succeeds without running the Promise boundary", async () => {
    const result = await Effect.runPromise(
      aanvraagGetByIdEffect(createFakeAanvraagStore(), FAKE_AANVRAAG.id)
    );

    expect(result).toEqual(FAKE_AANVRAAG);
  });

  it("knownHashGetEffect succeeds without running the Promise boundary", async () => {
    const result = await Effect.runPromise(
      knownHashGetEffect(createFakeKnownHashStore(), "bron-1", "ref-1")
    );

    expect(result).toBe("known-hash");
  });
});
