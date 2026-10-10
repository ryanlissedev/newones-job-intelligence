import { describe, expect, it } from "bun:test";

import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import {
  ApiCancelFault,
  ApiNotFoundFault,
  ApiUnauthenticatedFault,
  apiFaultToTrpcCode,
  fromApiPromise,
  runApiPromise,
  runApiPromiseAsTrpc,
} from "./index";

describe("runApiPromise", () => {
  it("returns success values", async () => {
    await expect(runApiPromise(Effect.succeed(42))).resolves.toBe(42);
  });

  it("rethrows typed ApiFaults", async () => {
    const pending = runApiPromise(
      Effect.fail(new ApiNotFoundFault({ message: "gone" }))
    );
    await expect(pending).rejects.toBeInstanceOf(ApiNotFoundFault);
  });

  it("maps abort to ApiCancelFault", async () => {
    const controller = new AbortController();
    const pending = runApiPromise(
      fromApiPromise(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
          new Promise(() => {})
      ),
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ApiCancelFault);
  });
});

describe("runApiPromiseAsTrpc", () => {
  it("maps ApiFault onto TRPCError", async () => {
    const pending = runApiPromiseAsTrpc(
      Effect.fail(
        new ApiUnauthenticatedFault({ message: "Authentication required" })
      )
    );
    await expect(pending).rejects.toBeInstanceOf(TRPCError);
    await expect(pending).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  });

  it("apiFaultToTrpcCode covers the Slice 9 matrix", () => {
    expect(
      apiFaultToTrpcCode(new ApiUnauthenticatedFault({ message: "x" }))
    ).toBe("UNAUTHORIZED");
    expect(apiFaultToTrpcCode(new ApiNotFoundFault({ message: "x" }))).toBe(
      "NOT_FOUND"
    );
    expect(apiFaultToTrpcCode(new ApiCancelFault({ message: "x" }))).toBe(
      "CLIENT_CLOSED_REQUEST"
    );
  });
});
