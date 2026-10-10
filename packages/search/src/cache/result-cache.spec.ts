import { describe, expect, it } from "bun:test";

import type { ResultCache } from "../types";
import { MemoryResultCache } from "./memory-result-cache";
import { createResultCache } from "./result-cache";

const stubConnect =
  (result: ResultCache | null) => (): Promise<ResultCache | null> =>
    Promise.resolve(result);

const failingConnect =
  (message: string) =>
  (_url: string, onError?: (connectMessage: string) => void) => {
    onError?.(message);
    return Promise.resolve(null);
  };

const fakeRedisCache: ResultCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};

describe("createResultCache backend resolution (RJC-388)", () => {
  it("resolves memory when REDIS_URL is unset", async () => {
    const resolution = await createResultCache(undefined, "development");
    expect(resolution.backend).toBe("memory");
    expect(resolution.cache).toBeInstanceOf(MemoryResultCache);
  });

  it("resolves redis when the connect factory succeeds", async () => {
    const resolution = await createResultCache(
      "redis://127.0.0.1:6379",
      "development",
      stubConnect(fakeRedisCache)
    );
    expect(resolution.backend).toBe("redis");
    expect(resolution.cache).toBe(fakeRedisCache);
  });

  it("falls back to memory outside production when Redis is unreachable", async () => {
    const resolution = await createResultCache(
      "redis://127.0.0.1:6379",
      "development",
      stubConnect(null)
    );
    expect(resolution.backend).toBe("memory");
    expect(resolution.cache).toBeInstanceOf(MemoryResultCache);
  });

  it("throws at startup when production has REDIS_URL set but unreachable", async () => {
    await expect(
      createResultCache(
        "redis://127.0.0.1:6379",
        "production",
        stubConnect(null)
      )
    ).rejects.toThrow(/Redis is unreachable/u);
  });

  it("does not throw in production when REDIS_URL is unset", async () => {
    const resolution = await createResultCache(undefined, "production");
    expect(resolution.backend).toBe("memory");
  });
});

describe("createResultCache Redis URL redaction (RJC-388)", () => {
  const passwordUrl = "redis://:hunter2secret@cache.internal.example:6379";

  it("logs the host but never the password", async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    // SAFETY: test-only stub matching Bun's process.stderr.write signature;
    // restored in `finally` regardless of assertion outcome.
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await createResultCache(passwordUrl, "development", stubConnect(null));
    } finally {
      process.stderr.write = originalWrite;
    }

    const logged = writes.join("");
    expect(logged).toContain("cache.internal.example");
    expect(logged).not.toContain("hunter2secret");
  });

  it("carries the connect error cause into the production startup error, redacted", async () => {
    await expect(
      createResultCache(
        passwordUrl,
        "production",
        failingConnect(`WRONGPASS invalid password for ${passwordUrl}`)
      )
    ).rejects.toThrow(
      /Cause: WRONGPASS invalid password for redis:\/\/cache\.internal\.example/u
    );

    try {
      await createResultCache(
        passwordUrl,
        "production",
        failingConnect("AUTH failed with hunter2secret")
      );
      throw new Error("Expected createResultCache to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Cause: AUTH failed with [REDACTED]");
      expect(message).not.toContain("hunter2secret");
    }
  });

  it("logs the connect error cause on the memory fallback, redacted", async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    // SAFETY: test-only stub matching Bun's process.stderr.write signature;
    // restored in `finally` regardless of assertion outcome.
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await createResultCache(
        passwordUrl,
        "development",
        failingConnect("ECONNREFUSED hunter2secret")
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    const logged = writes.join("");
    expect(logged).toContain('"reason":"redis_unreachable"');
    expect(logged).toContain('"cause":"ECONNREFUSED [REDACTED]"');
    expect(logged).not.toContain("hunter2secret");
  });

  it("throws an error naming the host but never the password", async () => {
    await expect(
      createResultCache(passwordUrl, "production", stubConnect(null))
    ).rejects.toThrow(/cache\.internal\.example/u);

    try {
      await createResultCache(passwordUrl, "production", stubConnect(null));
      throw new Error("Expected createResultCache to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("hunter2secret");
    }
  });
});
