import { expect, it } from "bun:test";

import { drainBacklog } from "./drain-backlog";

it("retains parked outcomes even when later passes empty the backlog", async () => {
  const outcomes = [
    { curated: 2, failed: 1, quarantined: 0, remaining: 2 },
    { curated: 1, failed: 0, quarantined: 1, remaining: 0 },
  ];
  const result = await drainBacklog(
    {
      deadlineMs: 100,
      input: null,
      signal: new AbortController().signal,
      start: { curated: 3, failed: 0, quarantined: 0, remaining: 5 },
    },
    () => {
      const outcome = outcomes.shift();
      if (!outcome) {
        throw new Error("Unexpected extra curation pass");
      }
      return Promise.resolve(outcome);
    },
    () => 0
  );
  expect(result).toEqual({
    curated: 6,
    failed: 1,
    quarantined: 1,
    remaining: 0,
  });
});

it("stops a pass that does not reduce the recoverable backlog", async () => {
  let calls = 0;
  const result = await drainBacklog(
    {
      deadlineMs: 100,
      input: null,
      signal: new AbortController().signal,
      start: { curated: 0, failed: 0, quarantined: 0, remaining: 2 },
    },
    () => {
      calls += 1;
      return Promise.resolve({
        curated: 0,
        failed: 0,
        quarantined: 0,
        remaining: 2,
      });
    },
    () => 0
  );
  expect(calls).toBe(1);
  expect(result.remaining).toBe(2);
});

it("runs a pass to count a backlog the skipped inline pass never counted", async () => {
  const outcomes = [
    { curated: 4, failed: 0, quarantined: 0, remaining: 3 },
    { curated: 3, failed: 0, quarantined: 0, remaining: 0 },
  ];
  const result = await drainBacklog(
    {
      backlogUnknown: true,
      deadlineMs: 100,
      input: null,
      signal: new AbortController().signal,
      start: { curated: 0, failed: 0, quarantined: 0, remaining: 0 },
    },
    () => {
      const outcome = outcomes.shift();
      if (!outcome) {
        throw new Error("Unexpected extra curation pass");
      }
      return Promise.resolve(outcome);
    },
    () => 0
  );
  expect(outcomes).toHaveLength(0);
  expect(result).toEqual({
    curated: 7,
    failed: 0,
    quarantined: 0,
    remaining: 0,
  });
});
