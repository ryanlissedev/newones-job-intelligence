/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- Test-only JSON Schema stub mirrors the derived descriptor type. */
import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  createCapabilityRegistry,
  defineCapability,
  productionCapabilityCatalog,
  toCapabilitySchema,
} from ".";
import type {
  BoundCapabilityInvoker,
  CapabilityBinding,
  CapabilityBindingSpec,
  CapabilityError,
  CapabilityParseResult,
  CapabilitySchema,
  InternalErrorReport,
  InvocationContext,
} from ".";

interface TestInvokerRegistry {
  readonly createInvoker: (
    binding: CapabilityBindingSpec
  ) => BoundCapabilityInvoker<unknown, CapabilityError>;
}

interface MissingRecordFailure extends CapabilityError<"RECORD_NOT_FOUND"> {
  readonly details: { readonly recordId: string };
}

const missingRecordFailureSchema: CapabilitySchema<MissingRecordFailure> =
  toCapabilitySchema(
    Schema.Struct({
      code: Schema.Literal("RECORD_NOT_FOUND"),
      details: Schema.Struct({ recordId: Schema.String }),
      message: Schema.String,
    })
  );

/**
 * Test-only adapter: replaces one member of a derived capability schema so the
 * registry's fail-closed guards can be exercised without a second schema
 * library (ADR-0014 / CTP-469).
 */
const overrideSchema = <Type>(
  schema: CapabilitySchema<Type, Type>,
  overrides: Partial<CapabilitySchema<Type, Type>>
): CapabilitySchema<Type, Type> => ({ ...schema, ...overrides });

const boundOperation = "GET /v1/records/search";
const noOpReporter = (): void => undefined;
const reporterExitProbeReady = "reporter-exit-probe-ready";
const reporterExitProbe = String.raw`
  import { Schema } from "effect";
  import {
    createCapabilityRegistry,
    defineCapability,
    toCapabilitySchema,
  } from "./packages/application/src/registry/index.ts";

  const capability = defineCapability({
    authorization: { permission: "records:read" },
    bindings: [{ operation: "GET /probe", transport: "rest" }],
    effect: "read",
    failureSchema: toCapabilitySchema(
      Schema.Struct({ code: Schema.String, message: Schema.String })
    ),
    grounding: true,
    handler: () => {
      throw new Error("probe failure");
    },
    id: "records.probe",
    inputSchema: toCapabilitySchema(Schema.Unknown),
    outcome: "Probe reporter cleanup",
    outputSchema: toCapabilitySchema(Schema.Unknown),
  });
  let reportCalls = 0;
  const result = createCapabilityRegistry([capability], {
    reportInternalError: () => {
      reportCalls += 1;
      return reportCalls === 1
        ? undefined
        : Promise.reject(new Error("probe reporter rejection"));
    },
    reporterTimeoutMs: 2000,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  console.log("${reporterExitProbeReady}");
  await result.registry.createInvoker({
    capabilityId: "records.probe",
    operation: "GET /probe",
    transport: "rest",
  })({}, {
    principal: {
      kind: "user",
      permissions: new Set(["records:read"]),
      subjectId: "user-1",
    },
    requestId: "probe-request",
  });
  await result.registry.createInvoker({
    capabilityId: "records.probe",
    operation: "GET /probe",
    transport: "rest",
  })({}, {
    principal: {
      kind: "user",
      permissions: new Set(["records:read"]),
      subjectId: "user-1",
    },
    requestId: "probe-rejection-request",
  });
`;

const authorizedContext = (): InvocationContext => ({
  operation: boundOperation,
  principal: {
    kind: "user",
    permissions: new Set(["records:read"]),
    subjectId: "user-1",
  },
  requestId: "request-1",
  transport: "rest",
});

const createReadCapability = (
  handler: (
    input: { readonly query: string },
    context: InvocationContext
  ) =>
    | { readonly ok: true; readonly value: string[] }
    | { readonly error: MissingRecordFailure; readonly ok: false }
    | Promise<
        | { readonly ok: true; readonly value: string[] }
        | { readonly error: MissingRecordFailure; readonly ok: false }
      >
) =>
  defineCapability({
    authorization: { permission: "records:read" },
    bindings: [{ operation: boundOperation, transport: "rest" }],
    effect: "read",
    failureSchema: missingRecordFailureSchema,
    grounding: true,
    handler,
    id: "records.search",
    inputSchema: toCapabilitySchema(
      Schema.Struct({ query: Schema.String.check(Schema.isMinLength(1)) })
    ),
    outcome: "Search records",
    outputSchema: toCapabilitySchema(Schema.Array(Schema.String)),
  });

const registryFor = (
  capability: ReturnType<typeof createReadCapability>,
  reportInternalError: (
    report: InternalErrorReport
  ) => Promise<void> | void = noOpReporter
) => {
  const result = createCapabilityRegistry([capability] as const, {
    reportInternalError,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.registry;
};

/* oxlint-disable anti-slop/no-unknown-parameters -- Test-only adapter exercises malformed boundary values. */
const invokeRegistry = (
  registry: TestInvokerRegistry,
  capabilityId: string,
  rawInput: unknown,
  rawTrustedInvocation: unknown
) => {
  // SAFETY: Tests intentionally pass InvocationContext-shaped and malformed values;
  // production callers cannot use this adapter.
  const candidate = rawTrustedInvocation as Partial<InvocationContext> | null;
  const operation = candidate?.operation ?? boundOperation;
  const transport = candidate?.transport ?? "rest";
  const invoker = registry.createInvoker({
    capabilityId,
    operation,
    transport,
  });
  if (!candidate) {
    // SAFETY: The malformed value is intentional input to the runtime validator.
    return invoker(rawInput, rawTrustedInvocation as never);
  }
  return invoker(rawInput, {
    principal: candidate.principal ?? null,
    requestId: candidate.requestId ?? "",
  });
};
/* oxlint-enable anti-slop/no-unknown-parameters */

describe("trusted invocation context", () => {
  it("snapshots a principal getter exactly once before authorization", async () => {
    let principalReads = 0;
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );
    const switchingContext = {
      operation: boundOperation,
      get principal(): InvocationContext["principal"] {
        principalReads += 1;
        if (principalReads === 1) {
          return null;
        }
        return authorizedContext().principal;
      },
      requestId: "request-switching-principal",
      transport: "rest",
    };

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      switchingContext
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
    }
    expect(principalReads).toBe(1);
    expect(handlerCalls).toBe(0);
  });

  it("fails closed when no principal is present", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      {
        ...authorizedContext(),
        principal: null,
        requestId: "request-unauthenticated",
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
      expect("requestId" in result.error ? result.error.requestId : null).toBe(
        "request-unauthenticated"
      );
    }
    expect(handlerCalls).toBe(0);
  });

  it("rejects malformed permissions with INVALID_CONTEXT", async () => {
    const registry = registryFor(
      createReadCapability(() => ({ ok: true, value: [] }))
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      {
        ...authorizedContext(),
        principal: {
          kind: "user",
          permissions: ["records:read"],
          subjectId: "user-1",
        },
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CONTEXT");
      expect("requestId" in result.error ? result.error.requestId : null).toBe(
        "request-1"
      );
    }
  });

  it("uses a safe request id when malformed context has none", async () => {
    const registry = registryFor(
      createReadCapability(() => ({ ok: true, value: [] }))
    );

    const result = await invokeRegistry(registry, "records.search", {}, null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CONTEXT");
      expect("requestId" in result.error ? result.error.requestId : null).toBe(
        "unavailable-request-id"
      );
    }
  });

  it("keeps transport and operation fixed outside request data", async () => {
    const observedContexts: InvocationContext[] = [];
    const base = createReadCapability((_input, context) => {
      observedContexts.push(context);
      return { ok: true, value: [] };
    });
    const capability = defineCapability({
      ...base,
      inputSchema: toCapabilitySchema(
        Schema.Struct({
          operation: Schema.String,
          query: Schema.String,
          transport: Schema.String,
        })
      ),
    });
    const registry = registryFor(capability);
    const binding = {
      capabilityId: "records.search",
      operation: boundOperation,
      transport: "rest" as const,
    };
    const invoker = registry.createInvoker(binding);
    binding.operation = "POST /mutated-after-binding";

    const result = await invoker(
      {
        operation: "POST /forged",
        query: "x",
        transport: "mcp",
      },
      {
        principal: authorizedContext().principal,
        requestId: "request-fixed-binding",
      }
    );

    expect(result.ok).toBe(true);
    expect(observedContexts[0]?.operation).toBe(boundOperation);
    expect(observedContexts[0]?.transport).toBe("rest");
  });

  it("fails closed when the trusted principal lacks permission", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      {
        ...authorizedContext(),
        principal: {
          kind: "agent",
          permissions: new Set(),
          subjectId: "agent-1",
        },
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(handlerCalls).toBe(0);
  });

  it("ignores a forged permission in raw input", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { permission: "records:read", query: "x" },
      {
        ...authorizedContext(),
        principal: {
          kind: "agent",
          permissions: new Set(),
          subjectId: "agent-1",
        },
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(handlerCalls).toBe(0);
  });
});

describe("explicit transport bindings", () => {
  it("rejects an unbound operation without calling the handler", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      {
        ...authorizedContext(),
        operation: "POST /v1/records/search",
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TRANSPORT_NOT_BOUND");
    }
    expect(handlerCalls).toBe(0);
  });

  it("rejects the right operation on the wrong transport", async () => {
    const registry = registryFor(
      createReadCapability(() => ({ ok: true, value: [] }))
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      {
        ...authorizedContext(),
        transport: "mcp",
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TRANSPORT_NOT_BOUND");
    }
  });
});

describe("capability handler contract", () => {
  it("rejects malformed input without calling the handler", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability(() => {
        handlerCalls += 1;
        return { ok: true, value: [] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    expect(handlerCalls).toBe(0);
  });

  it("calls a valid capability exactly once", async () => {
    let handlerCalls = 0;
    const registry = registryFor(
      createReadCapability((input, context) => {
        handlerCalls += 1;
        expect(input).toEqual({ query: "engineer" });
        expect(context.principal?.subjectId).toBe("user-1");
        return { ok: true, value: ["record-1"] };
      })
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "engineer" },
      authorizedContext()
    );

    expect(result).toEqual({ ok: true, value: ["record-1"] });
    expect(handlerCalls).toBe(1);
  });

  it("keeps a true empty result distinct from a failure", async () => {
    const registry = registryFor(
      createReadCapability(() => ({ ok: true, value: [] }))
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "nothing" },
      authorizedContext()
    );

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("preserves schema-valid domain failures", async () => {
    const domainFailure: MissingRecordFailure = {
      code: "RECORD_NOT_FOUND",
      details: { recordId: "record-404" },
      message: "Record does not exist",
    };
    const registry = registryFor(
      createReadCapability(() => ({ error: domainFailure, ok: false }))
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "missing" },
      authorizedContext()
    );

    expect(result).toEqual({ error: domainFailure, ok: false });
  });

  it("reports malformed success envelopes as contract violations", async () => {
    // SAFETY: This deliberately bypasses the compile-time contract to verify the
    // runtime boundary against a JavaScript or otherwise misbehaving handler.
    const malformedSuccess = { ok: true } as never;
    const reports: InternalErrorReport[] = [];
    const registry = registryFor(
      createReadCapability(() => malformedSuccess),
      (report) => {
        reports.push(report);
      }
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HANDLER_CONTRACT_VIOLATION");
    }
    expect(reports[0]?.phase).toBe("handler-contract");
  });

  it("reports malformed failure envelopes as contract violations", async () => {
    // SAFETY: This deliberately bypasses the compile-time contract to verify the
    // runtime boundary against a JavaScript or otherwise misbehaving handler.
    const malformedFailure = { ok: false } as never;
    const reports: InternalErrorReport[] = [];
    const registry = registryFor(
      createReadCapability(() => malformedFailure),
      (report) => {
        reports.push(report);
      }
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HANDLER_CONTRACT_VIOLATION");
    }
    expect(reports[0]?.phase).toBe("handler-contract");
  });

  it("reports invalid output as a contract violation", async () => {
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: boundOperation, transport: "rest" }],
      effect: "read",
      failureSchema: missingRecordFailureSchema,
      grounding: true,
      handler: () => ({ ok: true, value: ["not-accepted"] }),
      id: "records.search",
      inputSchema: toCapabilitySchema(Schema.Struct({ query: Schema.String })),
      outcome: "Search records",
      outputSchema: toCapabilitySchema(
        Schema.Array(Schema.String).check(
          Schema.makeFilter(() => "Never accepted")
        )
      ),
    });
    const reports: InternalErrorReport[] = [];
    const registryResult = createCapabilityRegistry([capability] as const, {
      reportInternalError: (report) => {
        reports.push(report);
      },
    });
    if (!registryResult.ok) {
      throw new Error(registryResult.error.message);
    }

    const result = await invokeRegistry(
      registryResult.registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HANDLER_CONTRACT_VIOLATION");
    }
    expect(reports[0]?.phase).toBe("output-schema");
  });

  it("reports malformed domain failures as contract violations", async () => {
    const rejectingFailureSchema = overrideSchema(missingRecordFailureSchema, {
      safeParseAsync: async (): Promise<
        CapabilityParseResult<MissingRecordFailure>
      > => {
        await Promise.resolve();
        return missingRecordFailureSchema.safeParse({});
      },
    });
    const failure: MissingRecordFailure = {
      code: "RECORD_NOT_FOUND",
      details: { recordId: "record-404" },
      message: "Record does not exist",
    };
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: boundOperation, transport: "rest" }],
      effect: "read",
      failureSchema: rejectingFailureSchema,
      grounding: true,
      handler: () => ({ error: failure, ok: false }),
      id: "records.search",
      inputSchema: toCapabilitySchema(Schema.Struct({ query: Schema.String })),
      outcome: "Search records",
      outputSchema: toCapabilitySchema(Schema.Array(Schema.String)),
    });
    const reports: InternalErrorReport[] = [];
    const registryResult = createCapabilityRegistry([capability] as const, {
      reportInternalError: (report) => {
        reports.push(report);
      },
    });
    if (!registryResult.ok) {
      throw new Error(registryResult.error.message);
    }

    const result = await invokeRegistry(
      registryResult.registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HANDLER_CONTRACT_VIOLATION");
    }
    expect(reports[0]?.phase).toBe("failure-schema");
  });

  it("awaits asynchronous input and output schemas", async () => {
    const inputSchema = toCapabilitySchema(
      Schema.Struct({
        query: Schema.String.check(
          Schema.makeFilter((query) =>
            query === "async" ? undefined : "Expected the async probe query"
          )
        ),
      })
    );
    const outputSchema = toCapabilitySchema(
      Schema.Array(Schema.String).check(
        Schema.makeFilter((records) =>
          records.length === 1 ? undefined : "Expected exactly one record"
        )
      )
    );
    // The registry must await schema validation: both adapters resolve on a
    // later tick, mirroring a schema with an asynchronous check.
    const asyncInputSchema = overrideSchema(inputSchema, {
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The adapter interface accepts unparsed boundary values by contract.
      safeParseAsync: async (value: unknown) => {
        await Promise.resolve();
        return inputSchema.safeParse(value);
      },
    });
    const asyncOutputSchema = overrideSchema(outputSchema, {
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The adapter interface accepts unparsed boundary values by contract.
      safeParseAsync: async (value: unknown) => {
        await Promise.resolve();
        return outputSchema.safeParse(value);
      },
    });
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: boundOperation, transport: "rest" }],
      effect: "read",
      failureSchema: missingRecordFailureSchema,
      grounding: true,
      handler: () => ({ ok: true, value: ["record-async"] }),
      id: "records.search",
      inputSchema: asyncInputSchema,
      outcome: "Search records asynchronously",
      outputSchema: asyncOutputSchema,
    });
    const registryResult = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });
    if (!registryResult.ok) {
      throw new Error(registryResult.error.message);
    }

    const result = await invokeRegistry(
      registryResult.registry,
      "records.search",
      { query: "async" },
      authorizedContext()
    );

    expect(result).toEqual({ ok: true, value: ["record-async"] });
  });
});

describe("internal error reporting", () => {
  it("contains a throwing handler-envelope getter", async () => {
    const secretError = new Error("secret envelope getter detail");
    const rawEnvelope = {};
    Object.defineProperty(rawEnvelope, "ok", {
      get: () => {
        throw secretError;
      },
    });
    // SAFETY: This deliberately bypasses the compile-time contract to verify a
    // hostile JavaScript result cannot reject the registry invocation.
    const hostileEnvelope = rawEnvelope as never;
    const reports: InternalErrorReport[] = [];
    const registry = registryFor(
      createReadCapability(() => hostileEnvelope),
      (report) => {
        reports.push(report);
      }
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    expect(reports).toEqual([
      {
        capabilityId: "records.search",
        cause: secretError,
        phase: "handler-contract",
        requestId: "request-1",
      },
    ]);
  });

  it("reports thrown errors while redacting the caller response", async () => {
    const secretError = new Error("database password is super-secret");
    const reports: InternalErrorReport[] = [];
    const registry = registryFor(
      createReadCapability(() => {
        throw secretError;
      }),
      (report) => {
        reports.push(report);
      }
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The capability could not be completed",
        requestId: "request-1",
      },
      ok: false,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      capabilityId: "records.search",
      cause: secretError,
      phase: "handler",
      requestId: "request-1",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("keeps the sanitized result when the best-effort reporter fails", async () => {
    const registry = registryFor(
      createReadCapability(() => {
        throw new Error("private handler detail");
      }),
      () => {
        throw new Error("private reporter detail");
      }
    );

    const result = await invokeRegistry(
      registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(result)).not.toContain("private");
    }
    expect(registry.health()).toEqual({
      reporterFailures: 1,
      reporterTimeouts: 0,
    });
  });

  it("bounds a never-resolving reporter and records the timeout", async () => {
    const capability = createReadCapability(() => {
      throw new Error("private handler detail");
    });
    const registryResult = createCapabilityRegistry([capability] as const, {
      reportInternalError: () =>
        // oxlint-disable-next-line promise/avoid-new -- Deliberately pending sink verifies timeout containment.
        new Promise<void>(() => {
          // This reporter intentionally never settles.
        }),
      reporterTimeoutMs: 5,
    });
    if (!registryResult.ok) {
      throw new Error(registryResult.error.message);
    }
    const invoker = registryResult.registry.createInvoker({
      capabilityId: "records.search",
      operation: boundOperation,
      transport: "rest",
    });

    const result = await invoker(
      { query: "x" },
      {
        principal: authorizedContext().principal,
        requestId: "request-timeout",
      }
    );

    expect(result.ok).toBe(false);
    expect(registryResult.registry.health()).toEqual({
      reporterFailures: 0,
      reporterTimeouts: 1,
    });
  });

  it("clears reporter timeouts after early resolve and rejection", async () => {
    const child = Bun.spawn([process.execPath, "-e", reporterExitProbe], {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
    });
    const readinessResult = await Promise.race([
      child.stdout
        .getReader()
        .read()
        .then(({ done, value }) => {
          if (done || !value) {
            return "closed" as const;
          }
          return new TextDecoder()
            .decode(value)
            .includes(reporterExitProbeReady)
            ? ("ready" as const)
            : ("unexpected-output" as const);
        }),
      Bun.sleep(10_000).then(() => "readiness-timeout" as const),
    ]);
    if (readinessResult !== "ready") {
      child.kill();
      await child.exited;
    }
    expect(readinessResult).toBe("ready");

    const exitResult = await Promise.race([
      child.exited,
      Bun.sleep(1000).then(() => "timeout" as const),
    ]);
    if (exitResult === "timeout") {
      child.kill();
      await child.exited;
    }

    expect(exitResult).toBe(0);
  });
});

describe("capability registry construction", () => {
  it("snapshots mutable capabilities, bindings, catalog, and reporter", async () => {
    const mutableBindings: CapabilityBinding[] = [
      { operation: boundOperation, transport: "rest" },
    ];
    const secretError = new Error("secret stable handler detail");
    const base = createReadCapability(() => {
      throw secretError;
    });
    const mutableDefinition = {
      ...base,
      bindings: mutableBindings,
    };
    const capability = defineCapability(mutableDefinition);
    const lateCapability = defineCapability({
      ...base,
      bindings: [{ operation: "GET /v1/records/late", transport: "rest" }],
      id: "records.late",
      outcome: "Late mutable capability",
    });
    const mutableCatalog: (typeof capability | typeof lateCapability)[] = [
      capability,
    ];
    const originalReports: InternalErrorReport[] = [];
    const replacementReports: InternalErrorReport[] = [];
    const mutableOptions = {
      reportInternalError: (report: InternalErrorReport): void => {
        originalReports.push(report);
      },
    };
    const result = createCapabilityRegistry(mutableCatalog, mutableOptions);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    mutableBindings.push({ operation: boundOperation, transport: "mcp" });
    mutableCatalog.push(lateCapability);
    mutableDefinition.handler = () => ({ ok: true, value: ["mutated"] });
    mutableOptions.reportInternalError = (report): void => {
      replacementReports.push(report);
    };

    const injectedBinding = await invokeRegistry(
      result.registry,
      "records.search",
      { query: "x" },
      { ...authorizedContext(), transport: "mcp" }
    );
    const injectedCapability = await invokeRegistry(
      result.registry,
      "records.late",
      { query: "x" },
      { ...authorizedContext(), operation: "GET /v1/records/late" }
    );
    const originalBinding = await invokeRegistry(
      result.registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(injectedBinding.ok).toBe(false);
    if (!injectedBinding.ok) {
      expect(injectedBinding.error.code).toBe("TRANSPORT_NOT_BOUND");
    }
    expect(injectedCapability.ok).toBe(false);
    if (!injectedCapability.ok) {
      expect(injectedCapability.error.code).toBe("UNKNOWN_CAPABILITY");
    }
    expect(originalBinding.ok).toBe(false);
    if (!originalBinding.ok) {
      expect(originalBinding.error.code).toBe("INTERNAL_ERROR");
    }
    expect(result.registry.catalog).toHaveLength(1);
    expect(Object.isFrozen(result.registry.catalog)).toBe(true);
    expect(Object.isFrozen(result.registry.catalog[0]?.bindings)).toBe(true);
    expect(originalReports[0]?.cause).toBe(secretError);
    expect(replacementReports).toHaveLength(0);
  });

  it("requires an internal error reporter for a non-empty catalog", () => {
    const capability = createReadCapability(() => ({ ok: true, value: [] }));

    const result = createCapabilityRegistry([capability] as const);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MISSING_ERROR_REPORTER");
    }
  });

  it("does not inspect capability getters before rejecting a missing reporter", () => {
    const capability = {
      get id(): string {
        throw new Error("unsafe capability getter");
      },
    };

    // SAFETY: The deliberately hostile object verifies that missing-reporter
    // validation returns a typed construction failure before definition access.
    const result = createCapabilityRegistry([capability as never]);

    expect(result).toEqual({
      error: {
        capabilityId: "unknown",
        code: "MISSING_ERROR_REPORTER",
        message: "A non-empty capability registry requires an error reporter",
      },
      ok: false,
    });
  });

  it("returns a typed failure for an unknown capability id", async () => {
    const registry = registryFor(
      createReadCapability(() => ({ ok: true, value: [] }))
    );

    const result = await invokeRegistry(
      registry,
      "records.unknown",
      {},
      authorizedContext()
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_CAPABILITY");
      expect("requestId" in result.error ? result.error.requestId : null).toBe(
        "request-1"
      );
    }
  });

  it("rejects duplicate capability ids", () => {
    const first = createReadCapability(() => ({ ok: true, value: [] }));
    const second = createReadCapability(() => ({ ok: true, value: [] }));

    const result = createCapabilityRegistry([first, second] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_CAPABILITY");
    }
  });

  it("rejects duplicate bindings across capabilities", () => {
    const first = createReadCapability(() => ({ ok: true, value: [] }));
    const second = defineCapability({
      ...first,
      id: "records.list",
      outcome: "List records",
    });

    const result = createCapabilityRegistry([first, second] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_BINDING");
    }
  });

  it("rejects a duplicate binding within one capability", () => {
    const base = createReadCapability(() => ({ ok: true, value: [] }));
    const [binding] = base.bindings;
    if (!binding) {
      throw new Error("Test capability must have one binding");
    }
    const capability = defineCapability({
      ...base,
      bindings: [binding, binding],
    });

    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_BINDING");
    }
  });

  it("rejects empty and whitespace capability metadata", () => {
    const base = createReadCapability(() => ({ ok: true, value: [] }));
    const invalidDefinitions = [
      defineCapability({ ...base, id: "" }),
      defineCapability({ ...base, id: " records.search" }),
      defineCapability({ ...base, outcome: " " }),
      defineCapability({
        ...base,
        authorization: { permission: "records:read " },
      }),
      defineCapability({
        ...base,
        bindings: [{ operation: " ", transport: "rest" }],
      }),
    ];

    for (const definition of invalidDefinitions) {
      const result = createCapabilityRegistry([definition] as const, {
        reportInternalError: noOpReporter,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_CAPABILITY");
      }
    }
  });

  it("validates executable fields and every schema at construction", () => {
    const base = createReadCapability(() => ({ ok: true, value: [] }));
    const invalidDefinitions = [
      { definition: { ...base, effect: "external-write" }, field: "effect" },
      { definition: { ...base, handler: null }, field: "handler" },
      { definition: { ...base, inputSchema: {} }, field: "inputSchema" },
      { definition: { ...base, outputSchema: {} }, field: "outputSchema" },
      { definition: { ...base, failureSchema: {} }, field: "failureSchema" },
    ] as const;

    for (const { definition, field } of invalidDefinitions) {
      // SAFETY: Deliberately malformed JavaScript definitions verify runtime
      // construction guards that TypeScript callers normally cannot bypass.
      const result = createCapabilityRegistry([definition as never], {
        reportInternalError: noOpReporter,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_CAPABILITY");
        expect(result.error.field).toBe(field);
      }
    }
  });

  it("returns INVALID_CAPABILITY when schema interface inspection throws", () => {
    const base = createReadCapability(() => ({ ok: true, value: [] }));
    const hostileSchema = {
      get safeParseAsync(): never {
        throw new Error("hostile schema getter");
      },
    };

    // SAFETY: The hostile schema verifies that JavaScript definitions cannot
    // escape the typed construction boundary through an accessor.
    const result = createCapabilityRegistry(
      [{ ...base, inputSchema: hostileSchema } as never],
      { reportInternalError: noOpReporter }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CAPABILITY");
      expect(result.error.capabilityId).toBe("records.search");
      expect(result.error.field).toBe("inputSchema");
    }
  });

  it("publishes frozen metadata descriptors without executable authority", () => {
    const capability = createReadCapability(() => ({ ok: true, value: [] }));
    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const [descriptor] = result.registry.catalog;

    expect(Object.isFrozen(result.registry.catalog)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor?.inputJsonSchema)).toBe(true);
    expect(descriptor?.inputJsonSchema).toMatchObject({ type: "object" });
    expect(descriptor).not.toHaveProperty("handler");
    expect(descriptor).not.toHaveProperty("inputSchema");
    expect(descriptor).not.toHaveProperty("outputSchema");
    expect(descriptor).not.toHaveProperty("failureSchema");
  });

  it("publishes generic JSON Schema metadata for non-MCP unknown input", () => {
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: "GET /generic", transport: "rest" }],
      effect: "read",
      failureSchema: missingRecordFailureSchema,
      grounding: true,
      handler: () => ({ ok: true, value: [] }),
      id: "records.generic",
      inputSchema: toCapabilitySchema(Schema.Unknown),
      outcome: "Accept generic input",
      outputSchema: toCapabilitySchema(Schema.Array(Schema.String)),
    });

    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry.catalog[0]?.inputJsonSchema).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
      expect(result.registry.catalog[0]?.inputJsonSchema).not.toHaveProperty(
        "~standard"
      );
      expect(Object.isFrozen(result.registry.catalog[0]?.inputJsonSchema)).toBe(
        true
      );
    }
  });

  it("rejects non-object MCP input with a typed construction error", () => {
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: "records_text", transport: "mcp" }],
      effect: "read",
      failureSchema: missingRecordFailureSchema,
      grounding: true,
      handler: () => ({ ok: true, value: [] }),
      id: "records.text",
      inputSchema: toCapabilitySchema(Schema.String),
      outcome: "Accept text input",
      outputSchema: toCapabilitySchema(Schema.Array(Schema.String)),
    });

    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        capabilityId: "records.text",
        code: "INVALID_CAPABILITY",
        field: "inputJsonSchema",
      });
    }
  });

  it("returns INVALID_CAPABILITY when JSON Schema conversion is unsupported", () => {
    const capability = defineCapability({
      authorization: { permission: "records:read" },
      bindings: [{ operation: "POST /date", transport: "rest" }],
      effect: "read",
      failureSchema: missingRecordFailureSchema,
      grounding: true,
      handler: () => ({ ok: true, value: [] }),
      id: "records.date",
      inputSchema: overrideSchema(toCapabilitySchema(Schema.Unknown), {
        toJsonSchema: (): Record<string, unknown> => {
          throw new TypeError("JSON Schema conversion is unsupported");
        },
      }),
      outcome: "Accept date input",
      outputSchema: toCapabilitySchema(Schema.Array(Schema.String)),
    });

    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        capabilityId: "records.date",
        code: "INVALID_CAPABILITY",
        field: "inputJsonSchema",
      });
    }
  });

  it("allows explicit zero bindings but exposes nothing", async () => {
    const base = createReadCapability(() => ({ ok: true, value: [] }));
    const capability = defineCapability({ ...base, bindings: [] });
    const result = createCapabilityRegistry([capability] as const, {
      reportInternalError: noOpReporter,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const invocation = await invokeRegistry(
      result.registry,
      "records.search",
      { query: "x" },
      authorizedContext()
    );

    expect(invocation.ok).toBe(false);
    if (!invocation.ok) {
      expect(invocation.error.code).toBe("TRANSPORT_NOT_BOUND");
    }
  });

  it("keeps the production catalog empty with zero bindings", () => {
    expect(productionCapabilityCatalog).toHaveLength(0);
    expect(productionCapabilityCatalog.some(() => true)).toBe(false);
  });
});
