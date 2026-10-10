import type { InvocationPrincipal } from "@ji/application/registry";
import type { Effect } from "effect";

import type {
  RegistryInvocationResult,
  SliceARegistry,
} from "../capabilities/registry-types";
import { invokeMcpTool } from "../capabilities/rest";
import type { RestRouteSpec } from "../capabilities/rest";
import type { RestJsonBody } from "../capabilities/transport-boundary";
import { mapInvocationCodeToTransportFault } from "./faults";
import type { TransportFault } from "./faults";
import { fromTransportPromise } from "./from-promise";
import { runTransportPromise } from "./run";
import type { RunTransportPromiseOptions } from "./run";

export type InvokeTransportEffectOptions = RunTransportPromiseOptions;

/**
 * When a registry invoker returns ok:false, lift the structured error into a
 * TransportFault so Effect callers see a typed failure instead of a soft result.
 * Success values pass through unchanged. Opt-in only (Slice 9).
 */
export const raiseInvocationFailure = (
  result: RegistryInvocationResult
): RegistryInvocationResult => {
  if (result.ok) {
    return result;
  }
  const { code, message } = result.error;
  throw mapInvocationCodeToTransportFault(code, message, result.error);
};

export const invokeRestEffectProgram = (
  registry: SliceARegistry,
  route: RestRouteSpec,
  input: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string
): Effect.Effect<RegistryInvocationResult, TransportFault> =>
  fromTransportPromise(async () => {
    const result = await registry.createInvoker({
      capabilityId: route.capabilityId,
      operation: route.operation,
      transport: "rest",
    })(input, { principal, requestId });
    return raiseInvocationFailure(result);
  });

/**
 * Opt-in REST invoker that runs through the per-request Effect Promise boundary.
 * Default createRestCapabilityHandler keeps the native Promise path.
 */
export const invokeRestEffect = (
  registry: SliceARegistry,
  route: RestRouteSpec,
  input: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string,
  options: InvokeTransportEffectOptions = {}
): Promise<RegistryInvocationResult> =>
  runTransportPromise(
    invokeRestEffectProgram(registry, route, input, principal, requestId),
    options
  );

export const invokeMcpToolEffectProgram = (
  registry: SliceARegistry,
  toolName: string,
  args: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string
): Effect.Effect<RegistryInvocationResult, TransportFault> =>
  fromTransportPromise(async () => {
    const result = await invokeMcpTool(
      registry,
      toolName,
      args,
      principal,
      requestId
    );
    return raiseInvocationFailure(result);
  });

/**
 * Opt-in MCP tool invoker through the Effect transport boundary.
 * Default createMcpHandler / tools/call keeps the native Promise path.
 */
export const invokeMcpToolEffect = (
  registry: SliceARegistry,
  toolName: string,
  args: RestJsonBody,
  principal: InvocationPrincipal | null,
  requestId: string,
  options: InvokeTransportEffectOptions = {}
): Promise<RegistryInvocationResult> =>
  runTransportPromise(
    invokeMcpToolEffectProgram(registry, toolName, args, principal, requestId),
    options
  );
