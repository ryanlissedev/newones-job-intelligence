import { describe, expect, it } from "bun:test";

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { InvocationPrincipal } from "@ji/application/registry";
import {
  createTestSliceARegistry,
  permissionsForRole,
  TEST_DEPLOYMENT_SCOPE_ID,
} from "@ji/application/registry";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { Hono } from "hono";

import type { PrincipalResolution } from "../capabilities/auth";
import { createMarktvragenChatHandler } from "./chat";
import type { ScreenContext } from "./prompt";
import { createTurnRateLimiter } from "./rate-limit";
import type { TurnEndReason } from "./turn-scope";
import { readActiveChatTurns } from "./turn-scope";

const principal: InvocationPrincipal = {
  kind: "user",
  permissions: permissionsForRole("recruiter"),
  subjectId: "user-1",
};

const okResolution: PrincipalResolution = { ok: true, principal };
const anonResolution: PrincipalResolution = { ok: true, principal: null };
const unavailableResolution: PrincipalResolution = {
  error: {
    code: "AUTH_SESSION_UNAVAILABLE",
    message: "Authentication service unavailable",
    requestId: "req-1",
  },
  ok: false,
};

const STREAM_CHUNKS: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { id: "t1", type: "text-start" },
  { delta: "Hoi", id: "t1", type: "text-delta" },
  { id: "t1", type: "text-end" },
  {
    finishReason: { raw: "stop", unified: "stop" },
    type: "finish",
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
      outputTokens: { reasoning: 0, text: 1, total: 1 },
    },
  },
];

const mockModel = () =>
  new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: convertArrayToReadableStream(STREAM_CHUNKS),
      }),
  });

const VALID_BODY = {
  messages: [
    {
      id: "m1",
      parts: [{ text: "Hoeveel aanvragen staan er open?", type: "text" }],
      role: "user",
    },
  ],
};

const TOOL_CALL_CHUNKS: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  {
    input: "{}",
    toolCallId: "call-1",
    toolName: "list_marts_tables",
    type: "tool-call",
  },
  {
    finishReason: { raw: "tool_calls", unified: "tool-calls" },
    type: "finish",
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
      outputTokens: { reasoning: 0, text: 0, total: 0 },
    },
  },
];

/** First step asks for `list_marts_tables`, second step answers with text. */
const toolCallingModel = () => {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      step += 1;
      return Promise.resolve({
        stream: convertArrayToReadableStream(
          step === 1 ? TOOL_CALL_CHUNKS : STREAM_CHUNKS
        ),
      });
    },
  });
};

/** Never yields a chunk; only the turn signal can end it. */
const hangingModel = () =>
  new MockLanguageModelV4({
    doStream: ({ abortSignal }) =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            abortSignal?.addEventListener("abort", () => {
              controller.error(abortSignal.reason);
            });
          },
        }),
      }),
  });

const failingModel = () =>
  new MockLanguageModelV4({
    doStream: () => Promise.reject(new Error("provider down")),
  });

interface EndEvent {
  readonly reason: TurnEndReason;
  readonly requestId: string;
}

const buildApp = ({
  model,
  resolution = okResolution,
  resolveSequence,
  turns = 30,
  turnTimeoutMs,
}: {
  readonly model?: () => MockLanguageModelV4;
  readonly resolution?: PrincipalResolution;
  /** Per-call resolutions; the last one repeats once exhausted. */
  readonly resolveSequence?: readonly PrincipalResolution[];
  readonly turns?: number;
  readonly turnTimeoutMs?: number;
} = {}) => {
  const { registry } = createTestSliceARegistry(TEST_DEPLOYMENT_SCOPE_ID);
  const ended = Promise.withResolvers<EndEvent>();
  let resolveCalls = 0;
  const app = new Hono().post(
    "/marktvragen/chat",
    createMarktvragenChatHandler({
      model: model ?? mockModel,
      onTurnEnd: (event) => {
        ended.resolve(event);
      },
      rateLimiter: createTurnRateLimiter({ maxPerWindow: turns }),
      registry,
      resolvePrincipal: () => {
        resolveCalls += 1;
        if (!resolveSequence) {
          return Promise.resolve(resolution);
        }
        const index = Math.min(resolveCalls - 1, resolveSequence.length - 1);
        // SAFETY: index is clamped into the non-empty sequence.
        return Promise.resolve(resolveSequence[index] as PrincipalResolution);
      },
      turnTimeoutMs,
    })
  );
  return { app, ended: ended.promise, resolveCalls: () => resolveCalls };
};

interface ChatRequestBody {
  readonly messages: readonly unknown[];
  readonly screen?: ScreenContext;
}

const postChat = (
  app: Hono,
  body: ChatRequestBody = VALID_BODY,
  signal?: AbortSignal
) =>
  app.request("/marktvragen/chat", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });

describe("marktvragen chat route", () => {
  it("returns 401 when the session resolves to no principal", async () => {
    const res = await postChat(buildApp({ resolution: anonResolution }).app);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("returns 503 when the session lookup fails", async () => {
    const res = await postChat(
      buildApp({ resolution: unavailableResolution }).app
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "AUTH_SESSION_UNAVAILABLE" },
    });
  });

  it("returns 429 once the per-user turn budget is spent", async () => {
    const { app } = buildApp({ turns: 1 });
    const first = await postChat(app);
    expect(first.status).toBe(200);
    const res = await postChat(app);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });

  it("returns 400 on a non-JSON body", async () => {
    const res = await buildApp().app.request("/marktvragen/chat", {
      body: "not-json",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when messages fail UIMessage validation", async () => {
    const res = await postChat(buildApp().app, {
      messages: [{ parts: "not-an-array", role: "user" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "INVALID_MESSAGES" },
    });
  });

  it("returns 503 when the chat model is not configured", async () => {
    const res = await postChat(
      buildApp({
        model: () => {
          throw new Error("OPENROUTER_API_KEY is required");
        },
      }).app
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "CHAT_NOT_CONFIGURED" },
    });
  });

  it("streams a UI message response and closes the turn as finished", async () => {
    const active = readActiveChatTurns();
    const { app, ended } = buildApp();
    const res = await postChat(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"delta":"Hoi"');
    const end = await ended;
    expect(end.reason).toBe("finished");
    expect(readActiveChatTurns()).toBe(active);
  });

  it("re-resolves the principal per tool call and fails closed once the session is revoked", async () => {
    const { app, ended, resolveCalls } = buildApp({
      model: toolCallingModel,
      resolveSequence: [okResolution, anonResolution],
    });
    const res = await postChat(app);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The revoked tool call ends the turn before any tool output streams.
    expect(text).toContain('"type":"tool-input-available"');
    expect(text).toContain('"type":"abort","reason":"revoked"');
    expect(text).not.toContain('"type":"tool-output-available"');
    expect(text).not.toContain('"delta":"Hoi"');
    expect(resolveCalls()).toBe(2);
    const end = await ended;
    expect(end.reason).toBe("revoked");
  });

  it("lets a tool call through while the session is still valid", async () => {
    const { app, ended } = buildApp({ model: toolCallingModel });
    const res = await postChat(app);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"code":"UNAUTHENTICATED"');
    expect(text).toContain('"delta":"Hoi"');
    const end = await ended;
    expect(end.reason).toBe("finished");
  });

  it("screen context grants no rights to an anonymous caller", async () => {
    const res = await postChat(buildApp({ resolution: anonResolution }).app, {
      ...VALID_BODY,
      screen: { kind: "dashboard" },
    });
    expect(res.status).toBe(401);
  });

  it("closes the turn as disconnected and releases resources when the browser goes away", async () => {
    const active = readActiveChatTurns();
    const { app, ended } = buildApp({ model: hangingModel });
    const request = new AbortController();
    const res = await postChat(app, VALID_BODY, request.signal);
    expect(res.status).toBe(200);
    request.abort();
    const end = await ended;
    expect(end.reason).toBe("disconnected");
    expect(readActiveChatTurns()).toBe(active);
  });

  it("closes the turn as timeout when the provider never answers", async () => {
    const { app, ended } = buildApp({ model: hangingModel, turnTimeoutMs: 20 });
    const res = await postChat(app);
    expect(res.status).toBe(200);
    const end = await ended;
    expect(end.reason).toBe("timeout");
  });

  it("closes the turn as error when the provider fails and never leaks the raw message", async () => {
    const { app, ended } = buildApp({ model: failingModel });
    const res = await postChat(app);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("provider down");
    expect(text).toContain("Er ging iets mis");
    const end = await ended;
    expect(end.reason).toBe("error");
  });
});

describe("createTurnRateLimiter", () => {
  it("admits up to the window budget and rejects beyond it", () => {
    let now = 1000;
    const limiter = createTurnRateLimiter({
      maxPerWindow: 2,
      now: () => now,
    });
    expect(limiter.check("u")).toBe(true);
    expect(limiter.check("u")).toBe(true);
    expect(limiter.check("u")).toBe(false);
    now += 3_600_001;
    expect(limiter.check("u")).toBe(true);
  });

  it("tracks subjects independently", () => {
    const limiter = createTurnRateLimiter({ maxPerWindow: 1 });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(true);
  });
});
