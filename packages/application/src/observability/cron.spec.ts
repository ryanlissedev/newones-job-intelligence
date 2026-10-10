import { describe, expect, it } from "bun:test";

import {
  instantFromZonedMoment,
  nextCronRun,
  parseCronExpression,
  zonedMoment,
} from "./cron";

const AMSTERDAM = "Europe/Amsterdam";

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** Fails the test rather than asserting a type the search may not return. */
const requireRun = (value: Date | null): Date => {
  if (value === null) {
    throw new Error("expected nextCronRun to find a match");
  }
  return value;
};

describe("parseCronExpression", () => {
  it.each([
    ["*/15 * * * *"],
    ["0 * * * *"],
    ["0 3 * * *"],
    ["0 0 1 * *"],
    ["30 6 * * 1-5"],
    ["0,30 8-18 * * *"],
    ["0 3 * * 7"],
  ])("accepts %s", (expression) => {
    expect(parseCronExpression(expression)).not.toBeNull();
  });

  it.each([
    ["", "empty"],
    ["* * * *", "four fields"],
    ["* * * * * *", "six fields"],
    ["60 * * * *", "minute out of range"],
    ["* 24 * * *", "hour out of range"],
    ["* * 0 * *", "day-of-month below one"],
    ["* * * 13 *", "month out of range"],
    ["* * * * 8", "day-of-week out of range"],
    ["*/0 * * * *", "zero step"],
    ["a * * * *", "non-numeric"],
    ["5-1 * * * *", "inverted range"],
  ])("rejects %s (%s)", (expression) => {
    expect(parseCronExpression(expression)).toBeNull();
  });

  it("treats day-of-week 7 as Sunday", () => {
    // 2026-09-06 is a Sunday.
    const after = new Date("2026-09-04T12:00:00.000Z");
    expect(iso(nextCronRun("0 12 * * 7", after, AMSTERDAM))).toBe(
      iso(nextCronRun("0 12 * * 0", after, AMSTERDAM))
    );
  });
});

describe("zonedMoment", () => {
  it("reads Amsterdam wall-clock fields, including midnight as hour 0", () => {
    expect(
      zonedMoment(new Date("2026-09-04T22:00:00.000Z"), AMSTERDAM)
    ).toEqual({ day: 5, hour: 0, minute: 0, month: 9, year: 2026 });
  });

  it("tracks the summer offset", () => {
    expect(
      zonedMoment(new Date("2026-07-01T10:00:00.000Z"), AMSTERDAM)
    ).toEqual({ day: 1, hour: 12, minute: 0, month: 7, year: 2026 });
  });
});

/**
 * DST is the case RJC-408 calls out. Amsterdam leaves summer time on
 * 2026-10-25, when 03:00 CEST becomes 02:00 CET and the 02:00 hour happens
 * twice; it enters summer time on 2026-03-29, when 02:00 CET jumps to 03:00
 * CEST and the 02:00 hour does not happen at all.
 */
describe("nextCronRun across the 2026-10-25 DST end", () => {
  it("keeps hourly runs on the hour before the change", () => {
    // 00:30 CEST -> next is 01:00 CEST.
    expect(
      iso(
        nextCronRun(
          "0 * * * *",
          new Date("2026-10-24T22:30:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-10-24T23:00:00.000Z");
  });

  it("resolves the repeated 02:00 to its first occurrence", () => {
    // 01:30 CEST -> 02:00 CEST, which is 00:00Z, not the 02:00 CET repeat.
    expect(
      iso(
        nextCronRun(
          "0 * * * *",
          new Date("2026-10-24T23:30:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-10-25T00:00:00.000Z");
  });

  it("fires a wall-clock time once, not twice, through the repeated hour", () => {
    // Already past 02:00 CEST: the next local match is 03:00 CET = 02:00Z.
    // The 02:00 CET repeat (01:00Z) is deliberately skipped, which is how
    // schedulers behave — one run per wall-clock time.
    expect(
      iso(
        nextCronRun(
          "0 * * * *",
          new Date("2026-10-25T00:30:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-10-25T02:00:00.000Z");
  });

  it("shifts a daily 03:00 run by an hour in UTC across the change", () => {
    // 24 Oct 03:00 is CEST (UTC+2); 25 Oct 03:00 is CET (UTC+1).
    expect(
      iso(
        nextCronRun(
          "0 3 * * *",
          new Date("2026-10-23T12:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-10-24T01:00:00.000Z");
    expect(
      iso(
        nextCronRun(
          "0 3 * * *",
          new Date("2026-10-24T12:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-10-25T02:00:00.000Z");
  });

  it("keeps every step of a quarter-hourly cron strictly increasing", () => {
    let cursor = new Date("2026-10-24T22:00:00.000Z");
    for (let step = 0; step < 24; step += 1) {
      const next = requireRun(nextCronRun("*/15 * * * *", cursor, AMSTERDAM));
      expect(next.getTime()).toBeGreaterThan(cursor.getTime());
      cursor = next;
    }
  });
});

describe("nextCronRun across the 2026-03-29 DST start", () => {
  it("skips a wall-clock time that does not exist", () => {
    // 02:30 does not occur on 29 March; the run lands on the 30th at 02:30
    // CEST, which is 00:30Z.
    expect(
      iso(
        nextCronRun(
          "30 2 * * *",
          new Date("2026-03-28T12:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-03-30T00:30:00.000Z");
  });

  it("still fires a time that does exist on the same day", () => {
    expect(
      iso(
        nextCronRun(
          "0 4 * * *",
          new Date("2026-03-29T00:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-03-29T02:00:00.000Z");
  });
});

describe("nextCronRun basics", () => {
  it("returns a strictly later instant", () => {
    const after = new Date("2026-09-04T12:00:00.000Z");
    const next = requireRun(nextCronRun("0 * * * *", after, AMSTERDAM));
    expect(next.getTime()).toBeGreaterThan(after.getTime());
  });

  it("honours day-of-month and month restrictions", () => {
    expect(
      iso(
        nextCronRun(
          "0 0 1 1 *",
          new Date("2026-09-04T12:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-12-31T23:00:00.000Z");
  });

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // The 1st, or any Monday, whichever comes first after 2026-09-04 (Friday).
    expect(
      iso(
        nextCronRun(
          "0 12 1 * 1",
          new Date("2026-09-04T12:00:00.000Z"),
          AMSTERDAM
        )
      )
    ).toBe("2026-09-07T10:00:00.000Z");
  });

  it("returns null for an unparseable interval", () => {
    expect(nextCronRun("not a cron", new Date(), AMSTERDAM)).toBeNull();
  });

  it("returns null for a pattern that can never match", () => {
    expect(
      nextCronRun("0 0 30 2 *", new Date("2026-09-04T12:00:00.000Z"), AMSTERDAM)
    ).toBeNull();
  });
});

describe("instantFromZonedMoment", () => {
  it("returns null for the hour skipped when clocks go forward", () => {
    expect(
      instantFromZonedMoment(
        { day: 29, hour: 2, minute: 30, month: 3, year: 2026 },
        AMSTERDAM
      )
    ).toBeNull();
  });

  it("returns the earlier instant for the hour repeated when clocks go back", () => {
    expect(
      iso(
        instantFromZonedMoment(
          { day: 25, hour: 2, minute: 30, month: 10, year: 2026 },
          AMSTERDAM
        )
      )
    ).toBe("2026-10-25T00:30:00.000Z");
  });
});
