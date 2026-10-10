import { describe, expect, it } from "bun:test";

import { InMemorySearchVersionStore, ZERO_SEQUENCE } from "../version";
import type { SearchVersionCheckpoint, SearchVersionStore } from "../version";
import type { ManticoreHttpClient } from "./client";
import { ManticoreSearchEngine } from "./engine";
import type { ManticoreBulkPayload, ManticoreSearchPayload } from "./json";

/**
 * The checkpoint read is a Postgres round trip on the search read path
 * (Neon over TLS in production), so these tests pin how often it happens.
 */
class CountingVersionStore implements SearchVersionStore {
  reads = 0;
  /** Non-null while reads are held open; resolving it releases them. */
  private gate: PromiseWithResolvers<null> | null = null;
  private readonly inner = new InMemorySearchVersionStore();

  advance(appliedSequence: bigint) {
    return this.inner.advance(appliedSequence);
  }

  async read(): Promise<SearchVersionCheckpoint> {
    this.reads += 1;
    if (this.gate) {
      await this.gate.promise;
    }
    return await this.inner.read();
  }

  startNewGeneration(schemaHash: string) {
    return this.inner.startNewGeneration(schemaHash);
  }

  /** Makes subsequent reads block until releaseReads() is called. */
  blockReads(): void {
    this.gate = Promise.withResolvers<null>();
  }

  releaseReads(): void {
    const { gate } = this;
    this.gate = null;
    gate?.resolve(null);
  }
}

const searchPayload: ManticoreSearchPayload = {
  hits: { hits: [], total: 0 },
};

const stubClient: ManticoreHttpClient = {
  bulk: (): Promise<ManticoreBulkPayload> => Promise.resolve({ errors: false }),
  request: (): Promise<ManticoreSearchPayload> =>
    Promise.resolve(searchPayload),
};

describe("applied-version reads (search read path)", () => {
  it("coalesces concurrent version reads into one store read", async () => {
    const store = new CountingVersionStore();
    const engine = new ManticoreSearchEngine(stubClient, store);
    store.blockReads();

    const inFlight = Promise.all([
      engine.getAppliedVersion(),
      engine.getAppliedVersion(),
      engine.getAppliedVersion(),
      engine.getAppliedVersion(),
    ]);
    // All four are waiting on the same blocked read before it is released.
    await Bun.sleep(0);
    expect(store.reads).toBe(1);

    store.releaseReads();
    const versions = await inFlight;

    expect(store.reads).toBe(1);
    for (const version of versions) {
      expect(version.appliedSequence).toBe(ZERO_SEQUENCE);
    }
  });

  it("does not hold a version between separate calls", async () => {
    const store = new CountingVersionStore();
    const engine = new ManticoreSearchEngine(stubClient, store);

    await engine.getAppliedVersion();
    await engine.getAppliedVersion();

    // Coalescing is in-flight only: a later caller must observe an advance
    // made in between, so sequential calls each read.
    expect(store.reads).toBe(2);
  });

  it("issues the version read alongside the Manticore query, not before it", async () => {
    const order: string[] = [];
    const store = new CountingVersionStore();
    const client: ManticoreHttpClient = {
      bulk: (): Promise<ManticoreBulkPayload> =>
        Promise.resolve({ errors: false }),
      request: (): Promise<ManticoreSearchPayload> => {
        order.push("manticore");
        return Promise.resolve(searchPayload);
      },
    };
    const engine = new ManticoreSearchEngine(client, store);
    store.blockReads();

    const search = engine.search({
      ast: { kind: "term", value: "azure" },
      filters: {},
      limit: 10,
      offset: 0,
    });

    // Both Manticore requests (the search and the scope-"active" archive
    // count) must already be out while the checkpoint read is still blocked;
    // awaiting the version first would hold them behind it.
    await Bun.sleep(0);
    expect(order).toEqual(["manticore", "manticore"]);

    store.releaseReads();
    await search;
  });
});
