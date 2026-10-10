import { describe, expect, it } from "bun:test";

import {
  AuthFault,
  isReadIoFault,
  RateLimitFault,
  Server5xxFault,
  ValidationFault,
} from "../effect-runtime";
import { createJsonLdClient } from "./client";
import { createJsonLdEffectClient } from "./client-effect";
import { asmlConfig } from "./configs/asml";
import { heroConfig } from "./configs/hero";
import { prorailConfig } from "./configs/prorail";

const detailUrl = (): string => {
  const [first] = Object.keys(heroConfig.detailFixtures ?? {});
  if (!first) {
    throw new Error("hero detailFixtures empty");
  }
  return first;
};

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

describe("json-ld Effect read adapter", () => {
  for (const operation of ["listing", "detail"] as const) {
    for (const abortOwner of ["run", "client"] as const) {
      it(`cancels ${operation} HTTP from the ${abortOwner} signal`, async () => {
        const runController = new AbortController();
        const clientController = new AbortController();
        const started = Promise.withResolvers<null>();
        const stopped = Promise.withResolvers<null>();
        let requests = 0;
        const client = createJsonLdEffectClient({
          config: heroConfig,
          fetchImpl: async (_url, init) => {
            requests += 1;
            const pending = hangUntilAbort(init);
            init?.signal?.addEventListener(
              "abort",
              () => stopped.resolve(null),
              {
                once: true,
              }
            );
            started.resolve(null);
            await pending;
            return new Response("unexpected completion");
          },
          liveEnabled: true,
          signal: clientController.signal,
        });
        const pending =
          operation === "listing"
            ? client.fetchListing(runController.signal)
            : client.fetchDetail(detailUrl(), runController.signal);
        await started.promise;
        const controller =
          abortOwner === "run" ? runController : clientController;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ _tag: "cancel" });
        await stopped.promise;
        expect(requests).toBe(1);
      });
    }
  }

  it("reads JSON listing fixtures as parsed payloads", async () => {
    const client = createJsonLdEffectClient({
      config: prorailConfig,
      liveEnabled: false,
    });
    const listing = await client.fetchListing();
    expect(listing).toHaveLength(16);
  });

  it("fixture listing/detail matches native Promise contract", async () => {
    const client = createJsonLdEffectClient({
      config: heroConfig,
      liveEnabled: false,
    });
    const listing = await client.fetchListing();
    expect(listing.length).toBeGreaterThan(0);
    const detail = await client.fetchDetail(detailUrl());
    expect(detail.url).toBe(detailUrl());
    expect(detail.jobPosting).not.toBeNull();
  });

  it("synthesises JobPosting from __NEXT_DATA__ like the Promise client", async () => {
    const [asmlUrl] = Object.keys(asmlConfig.detailFixtures ?? {});
    if (!asmlUrl) {
      throw new Error("asml detailFixtures empty");
    }
    const effectDetail = await createJsonLdEffectClient({
      config: asmlConfig,
      liveEnabled: false,
    }).fetchDetail(asmlUrl);
    const promiseDetail = await createJsonLdClient({
      config: asmlConfig,
      liveEnabled: false,
    }).fetchDetail(asmlUrl);
    expect(effectDetail.jobPosting).not.toBeNull();
    expect(effectDetail).toEqual(promiseDetail);
  });

  it("maps 401 through shared runtime", async () => {
    const client = createJsonLdEffectClient({
      config: heroConfig,
      fetchImpl: () => Promise.resolve(new Response("err", { status: 401 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toBeInstanceOf(AuthFault);
  });

  it("maps 429 through shared runtime", async () => {
    const client = createJsonLdEffectClient({
      config: heroConfig,
      fetchImpl: () =>
        Promise.resolve(
          new Response("err", {
            headers: { "Retry-After": "0" },
            status: 429,
          })
        ),
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toBeInstanceOf(RateLimitFault);
  });

  it("maps 5xx through shared runtime", async () => {
    const client = createJsonLdEffectClient({
      config: heroConfig,
      fetchImpl: () => Promise.resolve(new Response("err", { status: 503 })),
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toBeInstanceOf(Server5xxFault);
  });

  it("maps malformed JSON listings to validation faults", async () => {
    const client = createJsonLdEffectClient({
      config: prorailConfig,
      fetchImpl: () => Promise.resolve(new Response("not json")),
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toBeInstanceOf(ValidationFault);
  });

  it("maps invalid pagination and first-page pointers to validation faults", async () => {
    const invalidPaginationResponse = JSON.stringify({
      hits: [{ pageUrl: "/jobs/one" }],
      pagination: { page: -1, pageSize: 50, totalMatching: 1 },
    });
    const invalidPaginationClient = createJsonLdEffectClient({
      config: prorailConfig,
      fetchImpl: () => Promise.resolve(new Response(invalidPaginationResponse)),
      liveEnabled: true,
    });
    await expect(invalidPaginationClient.fetchListing()).rejects.toBeInstanceOf(
      ValidationFault
    );

    const invalidPointerClient = createJsonLdEffectClient({
      config: {
        ...prorailConfig,
        discovery: {
          kind: "json-listing",
          linkPattern: /^\/vacatures\/[^/]+\/[^/]+\/?$/u,
          pagination: {
            pageParam: "page",
            pagePointer: "pagination.page",
            pageSizeParam: "pageSize",
            pageSizePointer: "pagination.pageSize",
            totalPointer: "pagination.totalMatching",
          },
          url: "https://example.test/jobs?page=1&pageSize=50",
          urlPointer: "results[].pageUrl",
        },
      },
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            hits: [{ pageUrl: "/jobs/one" }],
            pagination: { page: 1, pageSize: 50, totalMatching: 1 },
          })
        ),
      liveEnabled: true,
    });
    await expect(invalidPointerClient.fetchListing()).rejects.toBeInstanceOf(
      ValidationFault
    );
  });

  it("honors AbortSignal during HTTP", async () => {
    const controller = new AbortController();
    const client = createJsonLdEffectClient({
      config: heroConfig,
      fetchImpl: async (_url, init) => {
        await hangUntilAbort(init);
        return new Response("late");
      },
      liveEnabled: true,
      signal: controller.signal,
    });
    const pending = client.fetchListing();
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
