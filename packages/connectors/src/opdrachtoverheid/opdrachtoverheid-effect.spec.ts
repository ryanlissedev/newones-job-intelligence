/* oxlint-disable eslint/require-await, unicorn/prefer-response-static-json, no-await-in-loop, anti-slop/require-safety-comment-for-type-assertion -- source fetch doubles stay readable while exercising the adapter boundary. */
import { describe, expect, it } from "bun:test";

import {
  AuthFault,
  isReadIoFault,
  Server5xxFault,
  ValidationFault,
} from "../effect-runtime";
import { createOpdrachtoverheidEffectClient } from "./client-effect";
import {
  OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES,
  OPDRACHTOVERHEID_MAX_RECORDS,
} from "./types";

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

describe("opdrachtoverheid Effect read adapter", () => {
  it("fixture listing matches native Promise contract", async () => {
    const client = createOpdrachtoverheidEffectClient({ liveEnabled: false });
    const listing = await client.fetchListing(4);
    expect(listing.items.length).toBeGreaterThan(0);
  });

  it("uses one bounded request and deduplicates the response", async () => {
    let requestBody: { limit?: number; offset?: number } | undefined;
    const client = createOpdrachtoverheidEffectClient({
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as {
          limit?: number;
          offset?: number;
        };
        return new Response(
          JSON.stringify({
            negometrix_tenders: [{ tender_id: "T-1" }, { tender_id: "T-1" }],
          })
        );
      },
      liveEnabled: true,
    });

    const listing = await client.fetchListing(4);

    expect(listing.items.map((tender) => tender.tender_id)).toEqual(["T-1"]);
    expect(listing.hasMore).toBe(true);
    expect(requestBody).toEqual({
      limit: OPDRACHTOVERHEID_MAX_RECORDS,
      offset: 0,
    });
  });

  it("rejects oversized listing headers and streamed bodies", async () => {
    const headerClient = createOpdrachtoverheidEffectClient({
      fetchImpl: async () =>
        new Response("{}", {
          headers: {
            "content-length": String(
              OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES + 1
            ),
          },
        }),
      liveEnabled: true,
    });
    await expect(headerClient.fetchListing(0)).rejects.toBeInstanceOf(
      ValidationFault
    );

    const bodyClient = createOpdrachtoverheidEffectClient({
      fetchImpl: async () =>
        new Response("x".repeat(OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES + 1)),
      liveEnabled: true,
    });
    await expect(bodyClient.fetchListing(0)).rejects.toBeInstanceOf(
      ValidationFault
    );
  });

  it("rejects malformed listing shapes and tender IDs", async () => {
    for (const payload of [
      {},
      { negometrix_tenders: [{}] },
      { negometrix_tenders: [{ tender_id: "  " }] },
    ]) {
      const client = createOpdrachtoverheidEffectClient({
        fetchImpl: async () => new Response(JSON.stringify(payload)),
        liveEnabled: true,
      });

      await expect(client.fetchListing(0)).rejects.toBeInstanceOf(
        ValidationFault
      );
    }
  });

  it("maps 401 through shared runtime", async () => {
    const client = createOpdrachtoverheidEffectClient({
      fetchImpl: () => Promise.resolve(new Response("err", { status: 401 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing(0)).rejects.toBeInstanceOf(AuthFault);
  });

  it("maps 5xx through shared runtime", async () => {
    const client = createOpdrachtoverheidEffectClient({
      fetchImpl: () => Promise.resolve(new Response("err", { status: 503 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing(0)).rejects.toBeInstanceOf(Server5xxFault);
  });

  it("honors AbortSignal during HTTP", async () => {
    const controller = new AbortController();
    const client = createOpdrachtoverheidEffectClient({
      fetchImpl: async (_url, init) => {
        await hangUntilAbort(init);
        return new Response("{}");
      },
      liveEnabled: true,
      signal: controller.signal,
    });
    const pending = client.fetchListing(0);
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

  it("bounds the live listing request and response body with timeoutMs", async () => {
    const client = createOpdrachtoverheidEffectClient({
      fetchImpl: async (_url, init) => {
        await hangUntilAbort(init);
        return new Response("{}");
      },
      liveEnabled: true,
      timeoutMs: 10,
    });

    await expect(client.fetchListing(0)).rejects.toBeInstanceOf(
      ValidationFault
    );
  });
});
