import { Schema } from "effect";

import { invocationTransports } from "./capability";
import type {
  CapabilityDefinition,
  CapabilityError,
  CapabilityFailure,
  CapabilityHandlerResult,
  InvocationContext,
  InvocationPrincipal,
} from "./capability";
import type {
  CapabilityParseResult,
  CapabilitySchema,
  SchemaType,
} from "./schema-helpers";
import { toCapabilitySchema } from "./schema-helpers";

/* oxlint-disable anti-slop/no-unknown-parameters -- This registry is the I/O boundary that validates untrusted input and context. */
/* oxlint-disable anti-slop/no-runtime-typeof -- Runtime checks are part of fail-closed validation at this untrusted boundary. */
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- The temporary record is inspected and converted to InvocationContext before use. */

type AnyCapability = CapabilityDefinition<
  string,
  CapabilitySchema,
  CapabilitySchema,
  CapabilityError
>;

export interface CapabilityDescriptor {
  readonly authorization: { readonly permission: string };
  readonly bindings: readonly Readonly<{
    operation: string;
    transport: InvocationContext["transport"];
  }>[];
  readonly effect: AnyCapability["effect"];
  readonly grounding: boolean;
  readonly id: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly outputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface CapabilityBindingSpec {
  readonly capabilityId: string;
  readonly operation: string;
  readonly transport: InvocationContext["transport"];
}

export interface TrustedInvocation {
  readonly principal: InvocationPrincipal | null;
  readonly requestId: string;
}

type CapabilityId<Catalog extends readonly AnyCapability[]> =
  Catalog[number]["id"];

type CapabilityById<
  Catalog extends readonly AnyCapability[],
  Id extends CapabilityId<Catalog>,
> = Extract<Catalog[number], { readonly id: Id }>;

type OutputOf<Capability> =
  Capability extends CapabilityDefinition<
    string,
    CapabilitySchema,
    infer OutputSchema,
    CapabilityError
  >
    ? SchemaType<OutputSchema>
    : never;

type DomainFailureOf<Capability> =
  Capability extends CapabilityDefinition<
    string,
    CapabilitySchema,
    CapabilitySchema,
    infer DomainFailure
  >
    ? DomainFailure
    : never;

const safeRequestId = "unavailable-request-id";
const defaultReporterTimeoutMs = 100;
const maximumReporterTimeoutMs = 5000;
const principalKinds = ["user", "agent", "service"] as const;
const transportNames = new Set<string>(invocationTransports);
const discardInternalError = (): Promise<void> => Promise.resolve();

export type InvocationErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "HANDLER_CONTRACT_VIOLATION"
  | "INTERNAL_ERROR"
  | "INVALID_CONTEXT"
  | "INVALID_INPUT"
  | "TRANSPORT_NOT_BOUND"
  | "UNKNOWN_CAPABILITY";

export interface InvocationError extends CapabilityError<InvocationErrorCode> {
  readonly requestId: string;
}

export type InvocationResult<
  Output,
  DomainFailure extends CapabilityError,
> = CapabilityHandlerResult<Output, DomainFailure | InvocationError>;

export type RegistryConstructionErrorCode =
  | "DUPLICATE_CAPABILITY"
  | "DUPLICATE_BINDING"
  | "INVALID_CAPABILITY"
  | "MISSING_ERROR_REPORTER";

export interface RegistryConstructionError extends CapabilityError<RegistryConstructionErrorCode> {
  readonly binding?: string;
  readonly capabilityId: string;
  readonly field?: string;
}

export type InternalErrorPhase =
  | "failure-schema"
  | "handler"
  | "handler-contract"
  | "input-schema"
  | "output-schema";

export interface InternalErrorReport {
  readonly capabilityId: string;
  readonly cause: unknown;
  readonly phase: InternalErrorPhase;
  readonly requestId: string;
}

export type InternalErrorReporter = (
  report: InternalErrorReport
) => Promise<void> | void;

export interface CapabilityRegistryOptions {
  readonly reportInternalError?: InternalErrorReporter;
  readonly reporterTimeoutMs?: number;
}

export interface CapabilityRegistryHealth {
  readonly reporterFailures: number;
  readonly reporterTimeouts: number;
}

export type CapabilityRegistryResult<
  Catalog extends readonly AnyCapability[],
> =
  | { readonly ok: true; readonly registry: CapabilityRegistry<Catalog> }
  | { readonly error: RegistryConstructionError; readonly ok: false };

export type BoundCapabilityInvoker<
  Output,
  DomainFailure extends CapabilityError,
> = (
  rawInput: unknown,
  trustedInvocation: TrustedInvocation
) => Promise<InvocationResult<Output, DomainFailure>>;

export interface CapabilityRegistry<Catalog extends readonly AnyCapability[]> {
  readonly catalog: readonly CapabilityDescriptor[];
  readonly createInvoker: {
    <const Id extends CapabilityId<Catalog>>(
      binding: CapabilityBindingSpec & { readonly capabilityId: Id }
    ): BoundCapabilityInvoker<
      OutputOf<CapabilityById<Catalog, Id & CapabilityId<Catalog>>>,
      DomainFailureOf<CapabilityById<Catalog, Id & CapabilityId<Catalog>>>
    >;
    (
      binding: CapabilityBindingSpec
    ): BoundCapabilityInvoker<unknown, CapabilityError>;
  };
  readonly health: () => CapabilityRegistryHealth;
}

const invocationFailure = (
  code: InvocationErrorCode,
  message: string,
  requestId: string
): CapabilityFailure<InvocationError> => ({
  error: { code, message, requestId },
  ok: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonblankTrimmed = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();

const snapshotPermissions = (
  permissions: unknown
): ReadonlySet<string> | null => {
  if (!(permissions instanceof Set)) {
    return null;
  }
  try {
    const values = [...Set.prototype.values.call(permissions)];
    for (const permission of values) {
      if (!isNonblankTrimmed(permission)) {
        return null;
      }
    }
    return new Set(values);
  } catch {
    return null;
  }
};

const snapshotPrincipal = (principal: unknown): InvocationPrincipal | null => {
  if (!isRecord(principal)) {
    return null;
  }
  try {
    const { kind, permissions: rawPermissions, subjectId } = principal;
    const permissions = snapshotPermissions(rawPermissions);
    const principalKind = principalKinds.find(
      (candidate) => candidate === kind
    );
    if (!principalKind || !isNonblankTrimmed(subjectId) || !permissions) {
      return null;
    }
    return Object.freeze({ kind: principalKind, permissions, subjectId });
  } catch {
    return null;
  }
};

const validateTrustedInvocation = (
  rawInvocation: unknown,
  binding: CapabilityBindingSpec
):
  | { readonly context: InvocationContext; readonly ok: true }
  | CapabilityFailure<InvocationError> => {
  if (!isRecord(rawInvocation)) {
    return invocationFailure(
      "INVALID_CONTEXT",
      "The trusted invocation context is invalid",
      safeRequestId
    );
  }

  let requestId = safeRequestId;
  try {
    const { principal: rawPrincipal, requestId: rawRequestId } = rawInvocation;
    if (isNonblankTrimmed(rawRequestId)) {
      requestId = rawRequestId;
    }

    if (!isNonblankTrimmed(rawRequestId)) {
      return invocationFailure(
        "INVALID_CONTEXT",
        "The trusted invocation context is invalid",
        requestId
      );
    }

    const principal =
      rawPrincipal === null ? null : snapshotPrincipal(rawPrincipal);
    if (rawPrincipal !== null && !principal) {
      return invocationFailure(
        "INVALID_CONTEXT",
        "The trusted invocation context is invalid",
        requestId
      );
    }

    return {
      context: Object.freeze({
        operation: binding.operation,
        principal,
        requestId,
        transport: binding.transport,
      }),
      ok: true,
    };
  } catch {
    return invocationFailure(
      "INVALID_CONTEXT",
      "The trusted invocation context is invalid",
      requestId
    );
  }
};

const authorize = (
  capability: AnyCapability,
  context: InvocationContext
):
  | { readonly ok: true; readonly principal: InvocationPrincipal }
  | CapabilityFailure<InvocationError> => {
  if (!context.principal) {
    return invocationFailure(
      "UNAUTHENTICATED",
      "Authentication is required for this capability",
      context.requestId
    );
  }

  if (!context.principal.permissions.has(capability.authorization.permission)) {
    return invocationFailure(
      "FORBIDDEN",
      "The principal is not allowed to invoke this capability",
      context.requestId
    );
  }

  return { ok: true, principal: context.principal };
};

const isBound = (
  capability: AnyCapability,
  context: InvocationContext
): boolean =>
  capability.bindings.some(
    (binding) =>
      binding.transport === context.transport &&
      binding.operation === context.operation
  );

// Internal contract, not a published capability schema — derived from the same
// Effect Schema SoT as every public contract (ADR-0014 / CTP-469).
const handlerEnvelopeSchema = toCapabilitySchema(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({ error: Schema.Unknown, ok: Schema.Literal(false) }),
  ])
);

interface MutableRegistryHealth {
  reporterFailures: number;
  reporterTimeouts: number;
}

const reportBestEffort = async (
  reporter: InternalErrorReporter,
  report: InternalErrorReport,
  reporterTimeoutMs: number,
  health: MutableRegistryHealth
): Promise<void> => {
  const timedOut = Symbol("reporter-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const reportResult = Promise.resolve(reporter(report));
    // oxlint-disable-next-line promise/avoid-new -- A cancellable native timer has no existing promise to reuse.
    const timeoutResult = new Promise<symbol>((resolve) => {
      timeoutHandle = setTimeout(resolve, reporterTimeoutMs, timedOut);
    });
    const result = await Promise.race([reportResult, timeoutResult]);
    if (result === timedOut) {
      health.reporterTimeouts += 1;
    }
  } catch {
    health.reporterFailures += 1;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
};

const contractViolation = async (
  reporter: InternalErrorReporter,
  capability: AnyCapability,
  context: InvocationContext,
  phase: InternalErrorPhase,
  cause: unknown,
  reporterTimeoutMs: number,
  health: MutableRegistryHealth
): Promise<CapabilityFailure<InvocationError>> => {
  await reportBestEffort(
    reporter,
    { capabilityId: capability.id, cause, phase, requestId: context.requestId },
    reporterTimeoutMs,
    health
  );
  return invocationFailure(
    "HANDLER_CONTRACT_VIOLATION",
    "The capability handler violated its internal contract",
    context.requestId
  );
};

const internalError = async (
  reporter: InternalErrorReporter,
  capability: AnyCapability,
  context: InvocationContext,
  phase: InternalErrorPhase,
  cause: unknown,
  reporterTimeoutMs: number,
  health: MutableRegistryHealth
): Promise<CapabilityFailure<InvocationError>> => {
  await reportBestEffort(
    reporter,
    { capabilityId: capability.id, cause, phase, requestId: context.requestId },
    reporterTimeoutMs,
    health
  );
  return invocationFailure(
    "INTERNAL_ERROR",
    "The capability could not be completed",
    context.requestId
  );
};

const invokeCapability = async (
  capability: AnyCapability,
  rawInput: unknown,
  context: InvocationContext,
  reporter: InternalErrorReporter,
  reporterTimeoutMs: number,
  health: MutableRegistryHealth
): Promise<InvocationResult<unknown, CapabilityError>> => {
  const authorization = authorize(capability, context);
  if (!authorization.ok) {
    return authorization;
  }

  if (!isBound(capability, context)) {
    return invocationFailure(
      "TRANSPORT_NOT_BOUND",
      "The capability is not bound to this transport operation",
      context.requestId
    );
  }

  let parsedInput: CapabilityParseResult<unknown>;
  try {
    parsedInput = await capability.inputSchema.safeParseAsync(rawInput);
  } catch (error) {
    return internalError(
      reporter,
      capability,
      context,
      "input-schema",
      error,
      reporterTimeoutMs,
      health
    );
  }
  if (!parsedInput.success) {
    return invocationFailure(
      "INVALID_INPUT",
      "The capability input is invalid",
      context.requestId
    );
  }

  let rawResult: CapabilityHandlerResult<unknown, CapabilityError>;
  try {
    rawResult = await capability.handler(parsedInput.data, {
      ...context,
      principal: authorization.principal,
    });
  } catch (error) {
    return internalError(
      reporter,
      capability,
      context,
      "handler",
      error,
      reporterTimeoutMs,
      health
    );
  }

  let parsedEnvelope: CapabilityParseResult<
    | { readonly ok: true; readonly value: unknown }
    | { readonly error: unknown; readonly ok: false }
  >;
  try {
    parsedEnvelope = await handlerEnvelopeSchema.safeParseAsync(rawResult);
  } catch (error) {
    return internalError(
      reporter,
      capability,
      context,
      "handler-contract",
      error,
      reporterTimeoutMs,
      health
    );
  }
  if (!parsedEnvelope.success) {
    return contractViolation(
      reporter,
      capability,
      context,
      "handler-contract",
      parsedEnvelope.error,
      reporterTimeoutMs,
      health
    );
  }

  if (parsedEnvelope.data.ok) {
    let parsedOutput: CapabilityParseResult<unknown>;
    try {
      parsedOutput = await capability.outputSchema.safeParseAsync(
        parsedEnvelope.data.value
      );
    } catch (error) {
      return internalError(
        reporter,
        capability,
        context,
        "output-schema",
        error,
        reporterTimeoutMs,
        health
      );
    }
    if (!parsedOutput.success) {
      return contractViolation(
        reporter,
        capability,
        context,
        "output-schema",
        parsedOutput.error,
        reporterTimeoutMs,
        health
      );
    }
    return { ok: true, value: parsedOutput.data };
  }

  let parsedFailure: CapabilityParseResult<CapabilityError>;
  try {
    parsedFailure = await capability.failureSchema.safeParseAsync(
      parsedEnvelope.data.error
    );
  } catch (error) {
    return internalError(
      reporter,
      capability,
      context,
      "failure-schema",
      error,
      reporterTimeoutMs,
      health
    );
  }
  if (!parsedFailure.success) {
    return contractViolation(
      reporter,
      capability,
      context,
      "failure-schema",
      parsedFailure.error,
      reporterTimeoutMs,
      health
    );
  }
  return { error: parsedFailure.data, ok: false };
};

const bindingKey = (transport: string, operation: string): string =>
  `${transport}:${operation}`;

const invalidCapabilityError = (
  capabilityId: string,
  field: string
): RegistryConstructionError => ({
  capabilityId,
  code: "INVALID_CAPABILITY",
  field,
  message: `Capability metadata is invalid: ${field}`,
});

const snapshotCapability = (
  capability: AnyCapability
):
  | { readonly capability: AnyCapability; readonly ok: true }
  | { readonly error: RegistryConstructionError; readonly ok: false } => {
  let capabilityId = "unknown";
  try {
    const {
      authorization,
      bindings: rawBindings,
      effect,
      failureSchema,
      grounding,
      handler,
      id,
      inputSchema,
      outcome,
      outputSchema,
    } = capability;
    if (typeof id === "string") {
      capabilityId = id;
    }
    const permission = authorization?.permission;
    if (!Array.isArray(rawBindings)) {
      return {
        error: invalidCapabilityError(capabilityId, "bindings"),
        ok: false,
      };
    }
    const bindings = rawBindings.map((binding) => {
      const { operation, transport } = binding;
      return Object.freeze({ operation, transport });
    });
    const snapshot: AnyCapability = Object.freeze({
      authorization: Object.freeze({ permission }),
      bindings: Object.freeze(bindings),
      effect,
      failureSchema,
      grounding,
      handler,
      id,
      inputSchema,
      outcome,
      outputSchema,
    });
    return { capability: snapshot, ok: true };
  } catch {
    return {
      error: invalidCapabilityError(capabilityId, "definition"),
      ok: false,
    };
  }
};

const deepFreezeJsonSchema = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreezeJsonSchema(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const toPlainJsonSchema = (
  schema: Record<string, unknown>
): Record<string, unknown> | null => {
  try {
    const schemaWithoutVendorMetadata = Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "~standard")
    );
    const serialized = JSON.stringify(
      schemaWithoutVendorMetadata,
      (
        _key: string,
        value: unknown
      ): boolean | null | number | object | string => {
        if (
          typeof value === "bigint" ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          value === undefined ||
          (typeof value === "number" && !Number.isFinite(value))
        ) {
          throw new TypeError("JSON Schema metadata must be JSON-compatible");
        }
        return value;
      }
    );
    if (serialized === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const jsonSchemaFromCapabilitySchema = (
  capability: AnyCapability,
  schemaType: "input" | "output"
):
  | {
      readonly jsonSchema: CapabilityDescriptor["inputJsonSchema"];
      readonly ok: true;
    }
  | { readonly error: RegistryConstructionError; readonly ok: false } => {
  let convertedSchema: unknown;
  try {
    // Derived from the Effect Schema SoT — never a hand-maintained descriptor.
    convertedSchema = (
      schemaType === "input" ? capability.inputSchema : capability.outputSchema
    ).toJsonSchema(schemaType);
  } catch {
    return {
      error: invalidCapabilityError(capability.id, `${schemaType}JsonSchema`),
      ok: false,
    };
  }
  if (!isRecord(convertedSchema)) {
    return {
      error: invalidCapabilityError(capability.id, `${schemaType}JsonSchema`),
      ok: false,
    };
  }
  const schema = toPlainJsonSchema(convertedSchema);
  if (!schema) {
    return {
      error: invalidCapabilityError(capability.id, `${schemaType}JsonSchema`),
      ok: false,
    };
  }
  const hasMcpBinding =
    schemaType === "input" &&
    capability.bindings.some((binding) => binding.transport === "mcp");
  if (hasMcpBinding && schema.type !== "object") {
    return {
      error: invalidCapabilityError(capability.id, "inputJsonSchema"),
      ok: false,
    };
  }
  return { jsonSchema: deepFreezeJsonSchema(schema), ok: true };
};

const toDescriptor = (
  capability: AnyCapability
):
  | { readonly descriptor: CapabilityDescriptor; readonly ok: true }
  | { readonly error: RegistryConstructionError; readonly ok: false } => {
  const inputSchemaResult = jsonSchemaFromCapabilitySchema(capability, "input");
  if (!inputSchemaResult.ok) {
    return inputSchemaResult;
  }
  const outputSchemaResult = jsonSchemaFromCapabilitySchema(
    capability,
    "output"
  );
  if (!outputSchemaResult.ok) {
    return outputSchemaResult;
  }
  return {
    descriptor: Object.freeze({
      authorization: Object.freeze({
        permission: capability.authorization.permission,
      }),
      bindings: capability.bindings,
      effect: capability.effect,
      grounding: capability.grounding,
      id: capability.id,
      inputJsonSchema: inputSchemaResult.jsonSchema,
      outcome: capability.outcome,
      outputJsonSchema: outputSchemaResult.jsonSchema,
    }),
    ok: true,
  };
};

/**
 * Recognises a derived capability schema adapter (ADR-0014 / CTP-469).
 *
 * `safeParseAsync` is what every validation phase below calls, so it is the
 * checked contract; the same adapter also exposes `~standard` and
 * `toJsonSchema` for the transports.
 */
const hasCapabilitySchemaInterface = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  try {
    return typeof value.safeParseAsync === "function";
  } catch {
    return false;
  }
};

const validateCapability = (
  capability: AnyCapability
): RegistryConstructionError | null => {
  const metadata: readonly [string, unknown][] = [
    ["id", capability.id],
    ["outcome", capability.outcome],
    ["authorization.permission", capability.authorization?.permission],
  ];
  for (const [field, value] of metadata) {
    if (!isNonblankTrimmed(value)) {
      return invalidCapabilityError(capability.id, field);
    }
  }
  if (!(["read", "internal-write"] as const).includes(capability.effect)) {
    return invalidCapabilityError(capability.id, "effect");
  }
  if (typeof capability.handler !== "function") {
    return invalidCapabilityError(capability.id, "handler");
  }
  const schemas: readonly [string, unknown][] = [
    ["inputSchema", capability.inputSchema],
    ["outputSchema", capability.outputSchema],
    ["failureSchema", capability.failureSchema],
  ];
  for (const [field, schema] of schemas) {
    if (!hasCapabilitySchemaInterface(schema)) {
      return invalidCapabilityError(capability.id, field);
    }
  }
  if (
    typeof capability.grounding !== "boolean" ||
    !Array.isArray(capability.bindings)
  ) {
    return invalidCapabilityError(capability.id, "grounding/bindings");
  }
  for (const binding of capability.bindings) {
    if (
      !isRecord(binding) ||
      !isNonblankTrimmed(binding.operation) ||
      typeof binding.transport !== "string" ||
      !transportNames.has(binding.transport)
    ) {
      return invalidCapabilityError(capability.id, "bindings");
    }
  }
  return null;
};

export const createCapabilityRegistry = <
  const Catalog extends readonly AnyCapability[],
>(
  catalog: Catalog,
  options: CapabilityRegistryOptions = {}
): CapabilityRegistryResult<Catalog> => {
  const catalogEntries = [...catalog];
  const { reportInternalError: reporter } = options;
  const requestedReporterTimeoutMs = options.reporterTimeoutMs;
  const reporterTimeoutMs =
    typeof requestedReporterTimeoutMs === "number" &&
    Number.isFinite(requestedReporterTimeoutMs) &&
    requestedReporterTimeoutMs > 0
      ? Math.min(requestedReporterTimeoutMs, maximumReporterTimeoutMs)
      : defaultReporterTimeoutMs;
  if (catalogEntries.length > 0 && typeof reporter !== "function") {
    return {
      error: {
        capabilityId: "unknown",
        code: "MISSING_ERROR_REPORTER",
        message: "A non-empty capability registry requires an error reporter",
      },
      ok: false,
    };
  }

  const capabilities = new Map<string, AnyCapability>();
  const bindings = new Set<string>();
  const capabilityDescriptors: CapabilityDescriptor[] = [];

  for (const rawCapability of catalogEntries) {
    const snapshotResult = snapshotCapability(rawCapability);
    if (!snapshotResult.ok) {
      return snapshotResult;
    }
    const { capability } = snapshotResult;
    const validationError = validateCapability(capability);
    if (validationError) {
      return { error: validationError, ok: false };
    }
    if (capabilities.has(capability.id)) {
      return {
        error: {
          capabilityId: capability.id,
          code: "DUPLICATE_CAPABILITY",
          message: `Duplicate capability id: ${capability.id}`,
        },
        ok: false,
      };
    }
    const descriptorResult = toDescriptor(capability);
    if (!descriptorResult.ok) {
      return descriptorResult;
    }
    capabilities.set(capability.id, capability);
    capabilityDescriptors.push(descriptorResult.descriptor);

    for (const binding of capability.bindings) {
      const key = bindingKey(binding.transport, binding.operation);
      if (bindings.has(key)) {
        return {
          error: {
            binding: key,
            capabilityId: capability.id,
            code: "DUPLICATE_BINDING",
            message: `Duplicate capability binding: ${key}`,
          },
          ok: false,
        };
      }
      bindings.add(key);
    }
  }

  const publicCatalog = Object.freeze(capabilityDescriptors);
  const health: MutableRegistryHealth = {
    reporterFailures: 0,
    reporterTimeouts: 0,
  };

  const createInvoker = (binding: CapabilityBindingSpec) => {
    const fixedBinding = Object.freeze({
      capabilityId: binding.capabilityId,
      operation: binding.operation,
      transport: binding.transport,
    });
    return (
      rawInput: unknown,
      trustedInvocation: TrustedInvocation
    ): Promise<InvocationResult<unknown, CapabilityError>> => {
      const parsedContext = validateTrustedInvocation(
        trustedInvocation,
        fixedBinding
      );
      if (!parsedContext.ok) {
        return Promise.resolve(parsedContext);
      }
      const capability = capabilities.get(fixedBinding.capabilityId);
      if (!capability) {
        return Promise.resolve(
          invocationFailure(
            "UNKNOWN_CAPABILITY",
            "The requested capability is not registered",
            parsedContext.context.requestId
          )
        );
      }
      return invokeCapability(
        capability,
        rawInput,
        parsedContext.context,
        // A non-empty catalog cannot reach this path without a reporter.
        reporter ?? discardInternalError,
        reporterTimeoutMs,
        health
      );
    };
  };

  // SAFETY: The map is built from this exact typed catalog, and every successful
  // invocation validates its output against the selected capability schema.
  const registry: CapabilityRegistry<Catalog> = {
    catalog: publicCatalog,
    createInvoker:
      createInvoker as CapabilityRegistry<Catalog>["createInvoker"],
    health: () => Object.freeze({ ...health }),
  };

  return { ok: true, registry };
};
