import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  fromTransportPromise,
  isTransportFault,
  mapInvocationCodeToTransportFault,
  raiseInvocationFailure,
  runTransportPromise,
  TransportCancelFault,
  TransportDependencyFault,
  TransportForbiddenFault,
  TransportNotFoundFault,
  TransportUnauthenticatedFault,
  TransportUnavailableFault,
  TransportValidationFault,
  transportFaultToHttpStatus,
  transportFaultToMcpJsonRpc,
  transportFaultToTrpcCode,
} from "./index";

describe("mapInvocationCodeToTransportFault", () => {
  it("maps auth and validation codes onto tagged transport faults", () => {
    expect(
      mapInvocationCodeToTransportFault("UNAUTHENTICATED", "auth required")
    ).toBeInstanceOf(TransportUnauthenticatedFault);
    expect(
      mapInvocationCodeToTransportFault("FORBIDDEN", "nope")
    ).toBeInstanceOf(TransportForbiddenFault);
    expect(
      mapInvocationCodeToTransportFault("INVALID_INPUT", "bad")
    ).toBeInstanceOf(TransportValidationFault);
    expect(
      mapInvocationCodeToTransportFault("NOT_FOUND", "missing")
    ).toBeInstanceOf(TransportNotFoundFault);
    expect(
      mapInvocationCodeToTransportFault("CAPABILITY_UNAVAILABLE", "down")
    ).toBeInstanceOf(TransportUnavailableFault);
    expect(mapInvocationCodeToTransportFault("BOOM", "explode")).toBeInstanceOf(
      TransportDependencyFault
    );
  });
});

describe("transport fault mappers", () => {
  it("maps faults to HTTP statuses used by REST", () => {
    expect(
      transportFaultToHttpStatus(
        new TransportUnauthenticatedFault({ message: "x" })
      )
    ).toBe(401);
    expect(
      transportFaultToHttpStatus(new TransportForbiddenFault({ message: "x" }))
    ).toBe(403);
    expect(
      transportFaultToHttpStatus(new TransportValidationFault({ message: "x" }))
    ).toBe(400);
    expect(
      transportFaultToHttpStatus(new TransportNotFoundFault({ message: "x" }))
    ).toBe(404);
    expect(
      transportFaultToHttpStatus(
        new TransportUnavailableFault({ message: "x" })
      )
    ).toBe(503);
    expect(
      transportFaultToHttpStatus(new TransportCancelFault({ message: "x" }))
    ).toBe(499);
    expect(
      transportFaultToHttpStatus(new TransportDependencyFault({ message: "x" }))
    ).toBe(500);
  });

  it("maps faults to MCP JSON-RPC codes", () => {
    expect(
      transportFaultToMcpJsonRpc(
        new TransportUnauthenticatedFault({ message: "auth" })
      )
    ).toEqual({ code: -32_003, message: "auth" });
    expect(
      transportFaultToMcpJsonRpc(
        new TransportValidationFault({ message: "bad args" })
      )
    ).toEqual({ code: -32_602, message: "bad args" });
    expect(
      transportFaultToMcpJsonRpc(
        new TransportUnavailableFault({ message: "down" })
      )
    ).toEqual({ code: -32_603, message: "down" });
  });

  it("maps faults to tRPC codes", () => {
    expect(
      transportFaultToTrpcCode(
        new TransportUnauthenticatedFault({ message: "x" })
      )
    ).toBe("UNAUTHORIZED");
    expect(
      transportFaultToTrpcCode(new TransportForbiddenFault({ message: "x" }))
    ).toBe("FORBIDDEN");
    expect(
      transportFaultToTrpcCode(new TransportValidationFault({ message: "x" }))
    ).toBe("BAD_REQUEST");
    expect(
      transportFaultToTrpcCode(new TransportNotFoundFault({ message: "x" }))
    ).toBe("NOT_FOUND");
    expect(
      transportFaultToTrpcCode(new TransportCancelFault({ message: "x" }))
    ).toBe("CLIENT_CLOSED_REQUEST");
    expect(
      transportFaultToTrpcCode(new TransportDependencyFault({ message: "x" }))
    ).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("runTransportPromise", () => {
  it("returns the success value", async () => {
    await expect(runTransportPromise(Effect.succeed("ok"))).resolves.toBe("ok");
  });

  it("rethrows typed TransportFaults", async () => {
    const pending = runTransportPromise(
      Effect.fail(new TransportNotFoundFault({ message: "missing" }))
    );
    await expect(pending).rejects.toBeInstanceOf(TransportNotFoundFault);
    await expect(pending).rejects.toMatchObject({ _tag: "not_found" });
  });

  it("maps an aborted signal to TransportCancelFault", async () => {
    const controller = new AbortController();
    const pending = runTransportPromise(
      fromTransportPromise(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
          new Promise(() => {})
      ),
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TransportCancelFault);
    await expect(pending).rejects.toMatchObject({ _tag: "cancel" });
  });

  it("maps a rejected Error through fromTransportPromise", async () => {
    const pending = runTransportPromise(
      fromTransportPromise(() =>
        Promise.reject(new Error("capability not found"))
      )
    );
    await expect(pending).rejects.toBeInstanceOf(TransportNotFoundFault);
  });
});

describe("raiseInvocationFailure", () => {
  it("passes through successful results", () => {
    const ok = { ok: true as const, value: { hello: "world" } };
    expect(raiseInvocationFailure(ok)).toEqual(ok);
  });

  it("throws a TransportFault for ok:false results", () => {
    expect(() =>
      raiseInvocationFailure({
        error: {
          code: "FORBIDDEN",
          message: "nope",
          requestId: "req-1",
        },
        ok: false,
      })
    ).toThrow(TransportForbiddenFault);
  });

  it("isTransportFault recognises thrown faults", () => {
    try {
      raiseInvocationFailure({
        error: {
          code: "INVALID_INPUT",
          message: "bad",
          requestId: "req-2",
        },
        ok: false,
      });
      expect.unreachable();
    } catch (error) {
      expect(isTransportFault(error)).toBe(true);
      if (!isTransportFault(error)) {
        expect.unreachable();
      }
      expect(transportFaultToHttpStatus(error)).toBe(400);
    }
  });
});
