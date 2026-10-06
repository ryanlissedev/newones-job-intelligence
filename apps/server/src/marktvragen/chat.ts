import { convertToModelMessages, stepCountIs, streamText } from "ai";
import type { LanguageModel, UIMessage } from "ai";
import type { Context } from "hono";
import { z } from "zod";

import type { PrincipalResolver } from "../capabilities/auth";
import { screenContextSchema, buildSystemPrompt } from "./prompt";
import type { TurnRateLimiter } from "./rate-limit";
import type { MarktvragenRegistry } from "./tools";
import { createMarktvragenTools } from "./tools";
import type { TurnEndReason } from "./turn-scope";
import { openChatTurnScope } from "./turn-scope";

/**
 * On-box Marktvragen chat (JI-DSH-07) — the agent-native replacement for the
 * Trigger.dev `chat.agent` task. Each turn is a plain streamText call inside
 * this process: no cloud runs, no per-turn cost, tools execute through the
 * same Slice A registry invokers every other surface uses.
 *
 * Authorization: the better-auth session resolves to an InvocationPrincipal
 * for the 401/429 gate, and every tool call re-resolves it (CTP-628) so a
 * revoked session stops the next action. The optional `screen` body field is
 * framing context only, never authority.
 *
 * Lifecycle: one Effect scope per turn (turn-scope.ts) owns the abort signal,
 * the turn timer and the disconnect listener. Provider stream and tools share
 * that signal; the scope closes on finish, abort, error, timeout or revocation.
 */
const requestSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  screen: screenContextSchema.optional(),
});

/** Whole-turn wall-clock budget, provider stream and tool calls included. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export interface MarktvragenChatDeps {
  readonly model: () => LanguageModel;
  readonly rateLimiter: TurnRateLimiter;
  readonly registry: MarktvragenRegistry;
  readonly resolvePrincipal: PrincipalResolver;
  readonly turnTimeoutMs?: number;
  /** Observability hook: fires once per turn with the reason it ended. */
  readonly onTurnEnd?: (event: {
    readonly reason: TurnEndReason;
    readonly requestId: string;
  }) => void;
}

const jsonError = (
  c: Context,
  status: 400 | 401 | 429 | 503,
  code: string,
  message: string
) => c.json({ error: { code, message } }, status);

export const createMarktvragenChatHandler =
  (deps: MarktvragenChatDeps) =>
  async (c: Context): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const resolved = await deps.resolvePrincipal(c.req.raw.headers, requestId);
    if (!resolved.ok) {
      return jsonError(
        c,
        503,
        resolved.error.code,
        "De authenticatiedienst is niet bereikbaar"
      );
    }
    if (!resolved.principal) {
      return jsonError(c, 401, "UNAUTHENTICATED", "Niet ingelogd");
    }
    if (!deps.rateLimiter.check(resolved.principal.subjectId)) {
      return jsonError(
        c,
        429,
        "RATE_LIMITED",
        "Te veel vragen in korte tijd — probeer het later opnieuw"
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "INVALID_BODY", "Request body is geen JSON");
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(c, 400, "INVALID_BODY", "Request body voldoet niet");
    }

    let modelMessages;
    try {
      // SAFETY: the zod check above proves `messages` is a non-empty array;
      // convertToModelMessages validates each element's UIMessage structure
      // and throws on anything else, which the catch turns into a 400.
      modelMessages = await convertToModelMessages(
        parsed.data.messages as UIMessage[]
      );
    } catch {
      return jsonError(c, 400, "INVALID_MESSAGES", "Ongeldige berichten");
    }

    let model: LanguageModel;
    try {
      model = deps.model();
    } catch {
      return jsonError(
        c,
        503,
        "CHAT_NOT_CONFIGURED",
        "Assistent-chat is niet geconfigureerd"
      );
    }

    const { headers } = c.req.raw;
    const scope = await openChatTurnScope({
      onClose: (reason) => deps.onTurnEnd?.({ reason, requestId }),
      requestSignal: c.req.raw.signal,
      timeoutMs: deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });

    const result = streamText({
      abortSignal: scope.signal,
      messages: modelMessages,
      model,
      onAbort: () => {
        // The scope already knows why (disconnect, timeout, revocation); this
        // only covers an abort the SDK raised on its own.
        void scope.close("error");
      },
      onError: () => {
        void scope.close("error");
      },
      onFinish: () => {
        void scope.close("finished");
      },
      stopWhen: stepCountIs(20),
      system: buildSystemPrompt(parsed.data.screen),
      tools: createMarktvragenTools(deps.registry, {
        onRevoked: () => {
          void scope.close("revoked");
        },
        requestIdPrefix: `chat:${requestId}`,
        resolvePrincipal: async () => {
          const fresh = await deps.resolvePrincipal(headers, requestId);
          return fresh.ok ? fresh.principal : null;
        },
        signal: scope.signal,
      }),
    });

    // Never forward raw errors — they can carry internals (SQLSTATE details,
    // connection strings). The agent already sees capability failures as
    // structured tool output.
    return result.toUIMessageStreamResponse({
      onError: () =>
        "Er ging iets mis bij het verwerken van je vraag. Probeer het opnieuw.",
    });
  };
