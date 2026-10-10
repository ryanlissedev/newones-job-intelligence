import { describe, expect, it } from "bun:test";

import { AuthFault, isReadIoFault, Server5xxFault } from "../effect-runtime";
import { createTenderNedEffectClient } from "./client-effect";

const hangUntilAbort = (init?: RequestInit): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- AbortSignal has no promise API
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

describe("tenderned Effect read adapter", () => {
  it("fixture listing/detail matches native Promise contract", async () => {
    const client = createTenderNedEffectClient({ liveEnabled: false });
    const listing = await client.fetchListing(0, {});
    expect(listing.content.length).toBeGreaterThan(0);
    const detail = await client.fetchDetail("fixture-pub-001");
    expect(detail).toBeTruthy();
  });

  it("maps 401 through shared runtime", async () => {
    const client = createTenderNedEffectClient({
      fetchImpl: () => Promise.resolve(new Response("err", { status: 401 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing(0, {})).rejects.toBeInstanceOf(AuthFault);
  });

  it("maps 5xx through shared runtime", async () => {
    const client = createTenderNedEffectClient({
      fetchImpl: () => Promise.resolve(new Response("err", { status: 503 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing(0, {})).rejects.toBeInstanceOf(
      Server5xxFault
    );
  });

  it("honors AbortSignal during HTTP", async () => {
    const controller = new AbortController();
    const client = createTenderNedEffectClient({
      fetchImpl: async (_url, init) => {
        await hangUntilAbort(init);
        return new Response("{}");
      },
      liveEnabled: true,
      signal: controller.signal,
    });
    const pending = client.fetchListing(0, {});
    await Bun.sleep(10);
    controller.abort();
    try {
      await pending;
      throw new Error("expected cancel");
    } catch (error) {
      expect(isReadIoFault(error)).toBe(true);
      if (isReadIoFault(error)) {
        expect(error._tag).toBe("cancel");
      }
    }
  });
});
