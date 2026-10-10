import { describe, expect, it } from "bun:test";

import {
  DEFAULT_HTTP_TIMEOUT_MS,
  HttpTimeoutError,
  resolveHttpTimeoutMs,
  withHttpTimeout,
} from "./http-timeout";

describe("connector HTTP timeout", () => {
  it("uses a positive finite 30-second default and rejects invalid values", () => {
    expect(resolveHttpTimeoutMs()).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(resolveHttpTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
    expect(() => resolveHttpTimeoutMs(0)).toThrow(
      "timeoutMs must be a positive finite number"
    );
    expect(() => resolveHttpTimeoutMs(Number.NaN)).toThrow(
      "timeoutMs must be a positive finite number"
    );
    expect(() => resolveHttpTimeoutMs(Number.POSITIVE_INFINITY)).toThrow(
      "timeoutMs must be a positive finite number"
    );
  });

  it("aborts a stalled fetch operation", async () => {
    let signal: AbortSignal | undefined;
    const pending = withHttpTimeout((operationSignal) => {
      signal = operationSignal;
      const request = Promise.withResolvers<never>();
      operationSignal.addEventListener(
        "abort",
        () => request.reject(operationSignal.reason),
        { once: true }
      );
      return request.promise;
    }, 10);

    await expect(pending).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("bounds a stalled response body with the same signal", async () => {
    let signal: AbortSignal | undefined;
    const pending = withHttpTimeout(async (operationSignal) => {
      signal = operationSignal;
      const response = {
        text: () => {
          const body = Promise.withResolvers<never>();
          operationSignal.addEventListener(
            "abort",
            () => body.reject(operationSignal.reason),
            { once: true }
          );
          return body.promise;
        },
      };
      return await response.text();
    }, 10);

    await expect(pending).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a request when the parent run signal aborts", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const request = Promise.withResolvers<never>();
    const pending = withHttpTimeout(
      (operationSignal) => {
        signal = operationSignal;
        operationSignal.addEventListener(
          "abort",
          () => request.reject(operationSignal.reason),
          { once: true }
        );
        return request.promise;
      },
      1000,
      controller.signal
    );
    const reason = new Error("run stopped");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(signal?.aborted).toBe(true);
  });

  it("returns a completed fetch and body operation", async () => {
    const result = await withHttpTimeout(
      async () => await Promise.resolve("ok"),
      10
    );

    expect(result).toBe("ok");
  });
});
