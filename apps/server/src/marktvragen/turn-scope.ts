import { Effect, Exit, Scope } from "effect";

/**
 * Why a chat turn ended. Every reason aborts the scope-owned signal, so the
 * provider stream and any in-flight tool call stop on the same edge.
 */
export type TurnEndReason =
  | "disconnected"
  | "error"
  | "finished"
  | "revoked"
  | "timeout";

export interface ChatTurnScope {
  /** Scope-owned signal handed to the provider stream and every tool call. */
  readonly signal: AbortSignal;
  /** Idempotent: the first reason wins, later calls are no-ops. */
  readonly close: (reason: TurnEndReason) => Promise<void>;
  readonly endReason: () => TurnEndReason | null;
}

export interface OpenChatTurnScopeInput {
  /** The HTTP request signal; fires when the browser disconnects. */
  readonly requestSignal: AbortSignal;
  /** Wall-clock budget for the whole turn, provider stream and tools included. */
  readonly timeoutMs: number;
  readonly onClose?: (reason: TurnEndReason) => void;
}

let activeTurns = 0;

/** Turns whose scope is open right now; the "active resources after disconnect" metric. */
export const readActiveChatTurns = (): number => activeTurns;

const makeTurnScope = (
  input: OpenChatTurnScopeInput
): Effect.Effect<ChatTurnScope> =>
  Effect.gen(function* openChatTurnScopeEffect() {
    const scope = yield* Scope.make();
    const controller = new AbortController();
    let endReason: TurnEndReason | null = null;
    let closing: Promise<void> | null = null;

    activeTurns += 1;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        activeTurns -= 1;
      })
    );

    const close = (reason: TurnEndReason): Promise<void> => {
      if (closing) {
        return closing;
      }
      endReason = reason;
      controller.abort(reason);
      closing = (async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        input.onClose?.(reason);
      })();
      return closing;
    };

    const timer = setTimeout(() => {
      void close("timeout");
    }, input.timeoutMs);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        clearTimeout(timer);
      })
    );

    const onDisconnect = (): void => {
      void close("disconnected");
    };
    if (input.requestSignal.aborted) {
      onDisconnect();
    } else {
      input.requestSignal.addEventListener("abort", onDisconnect, {
        once: true,
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          input.requestSignal.removeEventListener("abort", onDisconnect);
        })
      );
    }

    return {
      close,
      endReason: () => endReason,
      signal: controller.signal,
    };
  });

/**
 * Opens the Effect scope that owns one Marktvragen chat turn (CTP-628). The
 * scope holds the abort controller, the turn timer and the request-disconnect
 * listener; closing it for any reason releases all three and aborts the
 * signal the AI SDK and the tools observe. The AI SDK stays a narrow adapter:
 * it only ever sees `signal`.
 */
export const openChatTurnScope = (
  input: OpenChatTurnScopeInput
): Promise<ChatTurnScope> => Effect.runPromise(makeTurnScope(input));
