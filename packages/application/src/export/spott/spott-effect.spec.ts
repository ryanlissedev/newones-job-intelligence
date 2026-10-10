import { describe, expect, it } from "bun:test";

import {
  AuthFault,
  isReadIoFault,
  RateLimitFault,
  Server5xxFault,
  ValidationFault,
} from "@ji/connectors/effect-runtime";

import { createSpottEffectClient } from "./client-effect";

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

describe("spott Effect read adapter", () => {
  it("fixture list/get matches native Promise contract", async () => {
    const client = createSpottEffectClient({ liveEnabled: false });
    const list = await client.listVacancies();
    expect(list.items.length).toBeGreaterThan(0);
    const detail = await client.getVacancy("vacancy-fixture-001");
    expect(detail.id).toBe("vacancy-fixture-001");
  });

  it("uses the shared @ji/connectors/effect-runtime package boundary", async () => {
    const runtime = await import("@ji/connectors/effect-runtime");
    expect(runtime.DEFAULT_READ_IO_MAX_ATTEMPTS).toBe(3);
    expect(runtime.httpRequest).toBeDefined();
  });

  it("maps auth faults", async () => {
    const client = createSpottEffectClient({
      apiKey: "test-key",
      fetchImpl: () => Promise.resolve(new Response("err", { status: 401 })),
      liveEnabled: true,
    });
    await expect(client.listVacancies()).rejects.toBeInstanceOf(AuthFault);
  });

  it("maps 429 faults", async () => {
    const client = createSpottEffectClient({
      apiKey: "test-key",
      fetchImpl: () =>
        Promise.resolve(
          new Response("err", {
            headers: { "Retry-After": "0" },
            status: 429,
          })
        ),
      liveEnabled: true,
    });
    await expect(client.listVacancies()).rejects.toBeInstanceOf(RateLimitFault);
  });

  it("maps 5xx and bad JSON", async () => {
    const server = createSpottEffectClient({
      apiKey: "test-key",
      fetchImpl: () => Promise.resolve(new Response("err", { status: 500 })),
      liveEnabled: true,
    });
    await expect(server.listVacancies()).rejects.toBeInstanceOf(Server5xxFault);

    const badJson = createSpottEffectClient({
      apiKey: "test-key",
      fetchImpl: () => Promise.resolve(new Response("{bad", { status: 200 })),
      liveEnabled: true,
    });
    await expect(badJson.listVacancies()).rejects.toBeInstanceOf(
      ValidationFault
    );
  });

  it("fails fast without API key on live path", async () => {
    const previous = process.env.SPOTT_API_KEY;
    delete process.env.SPOTT_API_KEY;
    try {
      const client = createSpottEffectClient({
        fetchImpl: () => Promise.resolve(new Response("{}")),
        liveEnabled: true,
      });
      await expect(client.listVacancies()).rejects.toBeInstanceOf(AuthFault);
    } finally {
      if (previous === undefined) {
        delete process.env.SPOTT_API_KEY;
      } else {
        process.env.SPOTT_API_KEY = previous;
      }
    }
  });

  it("honors AbortSignal cancel during HTTP", async () => {
    const controller = new AbortController();
    const client = createSpottEffectClient({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        await hangUntilAbort(init);
        return new Response("{}");
      },
      liveEnabled: true,
      signal: controller.signal,
    });
    const pending = client.listVacancies();
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
