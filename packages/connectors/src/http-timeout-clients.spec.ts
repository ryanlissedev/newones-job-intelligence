import { describe, expect, it } from "bun:test";

import { HttpTimeoutError } from "./http-timeout";
import { createJsonLdClient } from "./json-ld/client";
import { bluetrailConfig } from "./json-ld/configs/bluetrail";
import { createOpdrachtoverheidClient } from "./opdrachtoverheid/client";
import { createStriiveClient } from "./striive/client";

const TIMEOUT_MS = 10;

const rejectOnAbort = (
  signal: AbortSignal | null | undefined
): Promise<never> => {
  if (!signal) {
    return Promise.reject(new Error("expected an AbortSignal"));
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const pending = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => pending.reject(signal.reason), {
    once: true,
  });
  return pending.promise;
};

const createLiveOperations = (fetchImpl: typeof fetch) => {
  const jsonLd = createJsonLdClient({
    config: bluetrailConfig,
    fetchImpl,
    liveEnabled: true,
    timeoutMs: TIMEOUT_MS,
  });
  const opdrachtoverheid = createOpdrachtoverheidClient({
    fetchImpl,
    liveEnabled: true,
    timeoutMs: TIMEOUT_MS,
  });
  const striive = createStriiveClient({
    fetchImpl,
    liveEnabled: true,
    timeoutMs: TIMEOUT_MS,
  });

  return [
    { name: "JSON-LD listing", run: () => jsonLd.fetchListing() },
    {
      name: "JSON-LD detail",
      run: () =>
        jsonLd.fetchDetail(
          "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/"
        ),
    },
    {
      name: "Opdrachtoverheid listing",
      run: () => opdrachtoverheid.fetchListing(0),
    },
    {
      name: "Opdrachtoverheid detail",
      run: () =>
        opdrachtoverheid.fetchDetail({
          detailUrl:
            "https://www.opdrachtoverheid.nl/inhuuropdracht/Org/example/T-1",
          webKey: "T-1",
        }),
    },
    {
      name: "Opdrachtoverheid sitemap",
      run: () => opdrachtoverheid.fetchSitemap(),
    },
    { name: "Striive listing", run: () => striive.fetchListing(1) },
  ];
};

describe("native connector HTTP timeouts", () => {
  it("aborts stalled requests for every live listing/detail path", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("expected the client to pass an AbortSignal");
        }
        signals.push(signal);
        return await rejectOnAbort(signal);
      },
      { preconnect: () => {} }
    );

    await Promise.all(
      createLiveOperations(fetchImpl).map(async (operation) => {
        await expect(operation.run(), operation.name).rejects.toBeInstanceOf(
          HttpTimeoutError
        );
      })
    );

    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("aborts stalled response bodies for every live listing/detail path", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          return Promise.reject(
            new Error("expected the client to pass an AbortSignal")
          );
        }
        signals.push(signal);
        const response = new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true }
              );
            },
          })
        );
        return Promise.resolve(response);
      },
      { preconnect: () => {} }
    );

    await Promise.all(
      createLiveOperations(fetchImpl).map(async (operation) => {
        await expect(operation.run(), operation.name).rejects.toBeInstanceOf(
          HttpTimeoutError
        );
      })
    );

    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps successful live responses working", async () => {
    const jsonLd = createJsonLdClient({
      config: bluetrailConfig,
      fetchImpl: Object.assign(
        () =>
          Promise.resolve(
            new Response(
              "<urlset><url><loc>https://www.bluetrail.nl/opdrachten/Interim/example/</loc></url></urlset>"
            )
          ),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
      timeoutMs: TIMEOUT_MS,
    });
    expect(await jsonLd.fetchListing()).toEqual([
      { url: "https://www.bluetrail.nl/opdrachten/Interim/example/" },
    ]);

    const opdrachtoverheid = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        () => Promise.resolve(new Response('{"negometrix_tenders":[]}')),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(opdrachtoverheid.fetchListing(0)).resolves.toEqual({
      hasMore: true,
      items: [],
    });

    const striive = createStriiveClient({
      fetchImpl: Object.assign(
        () => Promise.resolve(new Response('{"data":[],"total":0}')),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(striive.fetchListing(1)).resolves.toEqual({
      data: [],
      total: 0,
    });
  });

  it("does not invoke fetchImpl in fixture mode", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = Object.assign(
      () => {
        fetchCalls += 1;
        return Promise.reject(new Error("fixture mode must not fetch"));
      },
      { preconnect: () => {} }
    );

    const jsonLd = createJsonLdClient({
      config: bluetrailConfig,
      fetchImpl,
      liveEnabled: false,
      timeoutMs: TIMEOUT_MS,
    });
    const listing = await jsonLd.fetchListing();
    const [detail] = listing;
    if (!detail) {
      throw new Error("expected a JSON-LD fixture listing row");
    }
    await jsonLd.fetchDetail(detail.url);

    const opdrachtoverheid = createOpdrachtoverheidClient({
      fetchImpl,
      liveEnabled: false,
      timeoutMs: TIMEOUT_MS,
    });
    await opdrachtoverheid.fetchListing(0);
    await opdrachtoverheid.fetchDetail({
      detailUrl: "https://example.test/detail",
      webKey: "detail",
    });
    await opdrachtoverheid.fetchSitemap();

    const striive = createStriiveClient({
      fetchImpl,
      liveEnabled: false,
      timeoutMs: TIMEOUT_MS,
    });
    await striive.fetchListing(1);

    expect(fetchCalls).toBe(0);
  });
});
