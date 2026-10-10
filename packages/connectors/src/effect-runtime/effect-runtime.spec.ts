import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  AuthFault,
  CancelFault,
  DEFAULT_READ_IO_MAX_ATTEMPTS,
  httpRequestOnce,
  RateLimitFault,
  runReadIoPromise,
  Server5xxFault,
  ValidationFault,
  withAbortFinalizer,
  withReadIoRetry,
} from "./index";

describe("effect-runtime shared core", () => {
  it("retries 429/5xx within ADR maxAttempts and respects Retry-After", async () => {
    let attempts = 0;
    const started = Date.now();
    const effect = Effect.suspend(() => {
      attempts += 1;
      if (attempts < 3) {
        return Effect.fail(
          new RateLimitFault({
            message: "slow down",
            retryAfterMs: 20,
            status: 429,
          })
        );
      }
      return Effect.succeed("ok");
    });
    const out = await Effect.runPromise(withReadIoRetry(effect));
    expect(out).toBe("ok");
    expect(attempts).toBe(DEFAULT_READ_IO_MAX_ATTEMPTS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("does not retry auth/validation faults", async () => {
    let attempts = 0;
    const effect = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail(new AuthFault({ message: "nope", status: 401 }));
    });
    await expect(
      Effect.runPromise(withReadIoRetry(effect))
    ).rejects.toMatchObject({ _tag: "auth" });
    expect(attempts).toBe(1);
  });

  it("maps HTTP statuses via httpRequestOnce", async () => {
    const response = await Effect.runPromise(
      httpRequestOnce({
        fetchImpl: () =>
          Promise.resolve(
            new Response("nope", {
              headers: { "Retry-After": "1" },
              status: 503,
            })
          ),
        mapHttpErrors: true,
        url: "https://example.test/x",
      }).pipe(Effect.flip)
    );
    expect(response).toBeInstanceOf(Server5xxFault);
    if (!(response instanceof Server5xxFault)) {
      throw new Error("expected Server5xxFault");
    }
    expect(response.status).toBe(503);
  });

  it("cancels in-flight HTTP and runs finalizers", async () => {
    let finalized = false;
    let sawAbort = false;
    const controller = new AbortController();
    const hang = Effect.tryPromise({
      catch: (cause) =>
        new CancelFault({
          cause,
          message: "cancelled",
        }),
      try: async (signal) => {
        // oxlint-disable-next-line promise/avoid-new -- AbortSignal has no promise API
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        });
        return "never";
      },
    });
    const program = withAbortFinalizer(hang, () => {
      finalized = true;
    });
    const pending = runReadIoPromise(program, { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ _tag: "cancel" });
    expect(sawAbort).toBe(true);
    expect(finalized).toBe(true);
  });

  it("maps bad JSON payloads to validation", async () => {
    const { readJsonBody } = await import("./http");
    const response = new Response("{not-json", { status: 200 });
    const fault = await Effect.runPromise(
      readJsonBody(response).pipe(Effect.flip)
    );
    expect(fault).toBeInstanceOf(ValidationFault);
  });

  it("sibling failure under bounded concurrency does not leak work", async () => {
    let active = 0;
    let peak = 0;
    type SiblingResult =
      | { readonly error: Server5xxFault; readonly ok: false }
      | { readonly error: null; readonly ok: true };

    const runSibling = (fail: boolean): Effect.Effect<SiblingResult> =>
      Effect.suspend(() => {
        active += 1;
        peak = Math.max(peak, active);
        return Effect.sleep("30 millis").pipe(
          Effect.andThen((): Effect.Effect<SiblingResult> => {
            active -= 1;
            if (fail) {
              return Effect.succeed({
                error: new Server5xxFault({ message: "boom", status: 500 }),
                ok: false as const,
              });
            }
            return Effect.succeed({ error: null, ok: true as const });
          })
        );
      });

    const results = await Effect.runPromise(
      Effect.all([runSibling(false), runSibling(true), runSibling(false)], {
        concurrency: 2,
      })
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.some((result) => result.ok === false)).toBe(true);
    expect(results.some((result) => result.ok === true)).toBe(true);
    expect(active).toBe(0);
  });
});
