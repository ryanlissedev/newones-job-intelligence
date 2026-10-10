import type {
  CapabilitySchema,
  SchemaEncoded,
  SchemaType,
} from "./schema-helpers";

export const invocationTransports = [
  "internal",
  "trpc",
  "rest",
  "mcp",
] as const;

export type InvocationTransport = (typeof invocationTransports)[number];

export type PrincipalKind = "user" | "agent" | "service";

export interface InvocationPrincipal {
  readonly kind: PrincipalKind;
  readonly permissions: ReadonlySet<string>;
  readonly subjectId: string;
}

export interface InvocationContext {
  readonly operation: string;
  readonly principal: InvocationPrincipal | null;
  readonly requestId: string;
  readonly transport: InvocationTransport;
}

export type CapabilityEffect = "read" | "internal-write";

export interface CapabilityBinding {
  readonly operation: string;
  readonly transport: InvocationTransport;
}

export interface CapabilityError<
  Code extends string = string,
  Details = unknown,
> {
  readonly code: Code;
  readonly details?: Details;
  readonly message: string;
}

export interface CapabilitySuccess<Output> {
  readonly ok: true;
  readonly value: Output;
}

export interface CapabilityFailure<Failure extends CapabilityError> {
  readonly error: Failure;
  readonly ok: false;
}

export type CapabilityHandlerResult<Output, Failure extends CapabilityError> =
  | CapabilitySuccess<Output>
  | CapabilityFailure<Failure>;

/**
 * ADR-0014 / Slice 4 (CTP-469): capability schemas are Effect Schema adapters
 * ({@link CapabilitySchema}), not `z.ZodType`. `SchemaType` is the decoded
 * handler input; `SchemaEncoded` is the wire value a handler returns.
 */
export interface CapabilityDefinition<
  Id extends string,
  InputSchema extends CapabilitySchema,
  OutputSchema extends CapabilitySchema,
  DomainFailure extends CapabilityError,
> {
  readonly authorization: {
    readonly permission: string;
  };
  readonly bindings: readonly CapabilityBinding[];
  readonly effect: CapabilityEffect;
  readonly failureSchema: CapabilitySchema<DomainFailure>;
  readonly grounding: boolean;
  readonly handler: (
    input: SchemaType<InputSchema>,
    context: InvocationContext & { readonly principal: InvocationPrincipal }
  ) =>
    | CapabilityHandlerResult<SchemaEncoded<OutputSchema>, DomainFailure>
    | Promise<
        CapabilityHandlerResult<SchemaEncoded<OutputSchema>, DomainFailure>
      >;
  readonly id: Id;
  readonly inputSchema: InputSchema;
  readonly outcome: string;
  readonly outputSchema: OutputSchema;
}

export const defineCapability = <
  const Id extends string,
  InputSchema extends CapabilitySchema,
  OutputSchema extends CapabilitySchema,
  DomainFailure extends CapabilityError,
>(
  definition: CapabilityDefinition<Id, InputSchema, OutputSchema, DomainFailure>
): CapabilityDefinition<Id, InputSchema, OutputSchema, DomainFailure> =>
  definition;
