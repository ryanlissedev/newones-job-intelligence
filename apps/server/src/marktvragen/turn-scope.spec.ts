import { describe, expect, it } from "bun:test";

import type { TurnEndReason } from "./turn-scope";
import { openChatTurnScope, readActiveChatTurns } from "./turn-scope";

const open = (
  overrides: {
    readonly requestSignal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
) => {
  const reasons: TurnEndReason[] = [];
  const scopePromise = openChatTurnScope({
    onClose: (reason) => {
      reasons.push(reason);
    },
    requestSignal: overrides.requestSignal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 60_000,
  });
  return { reasons, scopePromise };
};

describe("openChatTurnScope (CTP-628)", () => {
  it("aborts the signal and releases the turn on close; later closes are no-ops", async () => {
    const before = readActiveChatTurns();
    const { reasons, scopePromise } = open();
    const scope = await scopePromise;
    expect(readActiveChatTurns()).toBe(before + 1);
    expect(scope.signal.aborted).toBe(false);

    await scope.close("finished");
    await scope.close("error");

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe("finished");
    expect(scope.endReason()).toBe("finished");
    expect(reasons).toEqual(["finished"]);
    expect(readActiveChatTurns()).toBe(before);
  });

  it("closes as disconnected when the request signal aborts", async () => {
    const request = new AbortController();
    const { reasons, scopePromise } = open({ requestSignal: request.signal });
    const scope = await scopePromise;

    request.abort();
    await Promise.resolve();

    expect(scope.signal.aborted).toBe(true);
    expect(scope.endReason()).toBe("disconnected");
    await scope.close("finished");
    expect(reasons).toEqual(["disconnected"]);
  });

  it("closes as disconnected immediately for an already-aborted request", async () => {
    const request = new AbortController();
    request.abort();
    const { scopePromise } = open({ requestSignal: request.signal });
    const scope = await scopePromise;
    expect(scope.endReason()).toBe("disconnected");
    expect(scope.signal.aborted).toBe(true);
  });

  it("closes as timeout once the turn budget elapses", async () => {
    const { reasons, scopePromise } = open({ timeoutMs: 5 });
    const scope = await scopePromise;
    const aborted = Promise.withResolvers<unknown>();
    scope.signal.addEventListener(
      "abort",
      () => aborted.resolve(scope.signal.reason),
      { once: true }
    );
    expect(await aborted.promise).toBe("timeout");
    await scope.close("finished");
    expect(scope.endReason()).toBe("timeout");
    expect(reasons).toEqual(["timeout"]);
  });
});
