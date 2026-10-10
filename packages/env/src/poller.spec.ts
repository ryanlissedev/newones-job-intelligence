import { describe, expect, it } from "bun:test";

import {
  POLLER_CONCURRENCY_DEFAULT,
  POLLER_CURATE_CONCURRENCY_DEFAULT,
  POLLER_FETCHES_PER_SECOND_DEFAULT,
  pollerEnvEffectSchemas,
} from "./poller";
import { Schema } from "./schema-helpers";

const slotSchema = Schema.Struct({
  POLLER_CONCURRENCY: pollerEnvEffectSchemas.POLLER_CONCURRENCY,
  POLLER_CURATE_CONCURRENCY: pollerEnvEffectSchemas.POLLER_CURATE_CONCURRENCY,
  POLLER_FETCHES_PER_SECOND: pollerEnvEffectSchemas.POLLER_FETCHES_PER_SECOND,
});
const decode = Schema.decodeUnknownSync(slotSchema);

describe("poller slot and rate settings", () => {
  it("defaults to 8 sources in flight, 8 fetches/s and 2 curation drains", () => {
    expect(decode({})).toEqual({
      POLLER_CONCURRENCY: "8",
      POLLER_CURATE_CONCURRENCY: "2",
      POLLER_FETCHES_PER_SECOND: "8",
    });
    expect([
      POLLER_CONCURRENCY_DEFAULT,
      POLLER_FETCHES_PER_SECOND_DEFAULT,
      POLLER_CURATE_CONCURRENCY_DEFAULT,
    ]).toEqual([8, 8, 2]);
  });

  it("keeps an operator override", () => {
    expect(
      decode({
        POLLER_CONCURRENCY: "2",
        POLLER_CURATE_CONCURRENCY: "1",
        POLLER_FETCHES_PER_SECOND: "4",
      })
    ).toEqual({
      POLLER_CONCURRENCY: "2",
      POLLER_CURATE_CONCURRENCY: "1",
      POLLER_FETCHES_PER_SECOND: "4",
    });
  });

  it("rejects zero and fractions", () => {
    for (const value of ["0", "1.5", "-2"]) {
      expect(() => decode({ POLLER_FETCHES_PER_SECOND: value })).toThrow(
        "POLLER_FETCHES_PER_SECOND must be a positive whole number of requests per second"
      );
    }
  });
});
