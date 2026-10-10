import { describe, expect, it } from "bun:test";

import {
  boundDedupKey,
  buildDedupKey,
  closingMomentInstant,
  DEDUP_KEY_MAX_BYTES,
  hasClosingMomentPassed,
} from "./types";

const AMSTERDAM_TIME_ZONE = "Europe/Amsterdam";

interface AmsterdamWallClockParts {
  date: string;
  time: string;
}

/** Renders `instant` as its Europe/Amsterdam wall-clock components, so a
 * test can build a naive (no-offset) closing string the way every affected
 * source actually publishes one (CTM's `sluitingstijd`, Opdrachtoverheid's
 * `tender_offline_date`, Striive's `closingDateClient`). */
const amsterdamWallClockParts = (instant: Date): AmsterdamWallClockParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: AMSTERDAM_TIME_ZONE,
    year: "numeric",
  }).formatToParts(instant);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
};

describe("hasClosingMomentPassed", () => {
  it("is not passed for a naive timestamp later today (RJC-376 regression)", () => {
    // The bug: truncating "later today" to a bare date and comparing
    // against midnight UTC/local made this incorrectly read as closed,
    // even though the real deadline (a few minutes from now) has not
    // arrived. Reproduced with both separator styles seen at the sources
    // (CTM/Striive use "T", Opdrachtoverheid uses a space).
    const laterToday = new Date(Date.now() + 5 * 60 * 1000);
    const { date, time } = amsterdamWallClockParts(laterToday);

    expect(hasClosingMomentPassed(`${date}T${time}`)).toBe(false);
    expect(hasClosingMomentPassed(`${date} ${time}`)).toBe(false);
  });

  it("is passed for a naive timestamp earlier yesterday", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { date } = amsterdamWallClockParts(yesterday);

    expect(hasClosingMomentPassed(`${date}T00:00:01`)).toBe(true);
  });

  it("reads a bare date as open through the end of that day, not from midnight", () => {
    // The bare-date convention this fix chose: a source that only ever
    // publishes a date (no time-of-day) means "open through end of day",
    // never closed the instant that day begins.
    const { date: today } = amsterdamWallClockParts(new Date());

    expect(hasClosingMomentPassed(today)).toBe(false);
  });

  it("treats a bare date from yesterday as closed", () => {
    const { date: yesterday } = amsterdamWallClockParts(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    expect(hasClosingMomentPassed(yesterday)).toBe(true);
  });

  it("is never passed when closing information is absent -- UNKNOWN, not auto-closed", () => {
    const missing: string | undefined = undefined;

    expect(hasClosingMomentPassed(missing)).toBe(false);
    expect(hasClosingMomentPassed(null)).toBe(false);
    expect(hasClosingMomentPassed("")).toBe(false);
    expect(hasClosingMomentPassed("   ")).toBe(false);
  });

  it("is never passed for malformed/unrecognised input rather than throwing", () => {
    // "31-12-2026" (a plausible real-world DD-MM-YYYY input, not synthetic
    // noise) lands in the bare-date branch, where it used to reach
    // Intl.DateTimeFormat as an Invalid Date and throw RangeError -- the
    // record it belongs to must keep normalising, not crash.
    expect(hasClosingMomentPassed("31-12-2026")).toBe(false);
    expect(hasClosingMomentPassed("not-a-date")).toBe(false);
    expect(hasClosingMomentPassed("31-12-2026T10:00:00")).toBe(false);
  });

  it("honours an explicit UTC offset instead of reinterpreting it as Amsterdam wall clock", () => {
    // 23:30 UTC is 01:30 the next day in Amsterdam (UTC+2, summer) -- if the
    // offset were ignored and the digits re-read as Amsterdam local time,
    // this would flip a day early.
    const inTenMinutesUtc = new Date(Date.now() + 10 * 60 * 1000);
    const isoWithZ = inTenMinutesUtc.toISOString();

    expect(hasClosingMomentPassed(isoWithZ)).toBe(false);

    const tenMinutesAgoUtc = new Date(
      Date.now() - 10 * 60 * 1000
    ).toISOString();

    expect(hasClosingMomentPassed(tenMinutesAgoUtc)).toBe(true);
  });

  it("pins the Europe/Amsterdam interpretation of a naive timestamp against a fixed instant", () => {
    // 2026-06-15 is CEST (Amsterdam UTC+2). Freezing `Date.now()` makes this
    // deterministic instead of relative to the real clock, and pins the
    // exact offset used: a naive "HH:mm" string is read as Amsterdam local
    // time, not the deploy host's local time and not naive UTC (if it were
    // read as UTC, the "closed" and "open" cases below would swap).
    const realDateNow = Date.now;
    // now == 2026-06-15T20:15:00.000Z == 2026-06-15T22:15:00 Amsterdam (CEST, UTC+2)
    Date.now = () => new Date("2026-06-15T20:15:00.000Z").getTime();
    try {
      // 22:14 Amsterdam local == 20:14Z, one minute before "now" -> closed.
      expect(hasClosingMomentPassed("2026-06-15T22:14:00")).toBe(true);
      // 22:16 Amsterdam local == 20:16Z, one minute after "now" -> still open.
      expect(hasClosingMomentPassed("2026-06-15T22:16:00")).toBe(false);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe("closingMomentInstant", () => {
  it("resolves a bare date to Amsterdam end-of-day, not the start of the next day (codex review, RJC-394 amendment)", () => {
    // Bug: reconstructing the Amsterdam wall clock via
    // Intl.DateTimeFormat.formatToParts + Date.UTC drops the naive
    // instant's millisecond remainder (formatToParts carries no
    // fractional-second field), which perturbed the offset just enough to
    // round "23:59:59.999 Amsterdam" forward into "00:00:00.xxx" of the
    // *next* calendar day. Pinned for both a summer (CEST, UTC+2) and a
    // winter (CET, UTC+1) date so the fix isn't offset-specific.
    expect(closingMomentInstant("2026-06-15")?.toISOString()).toBe(
      "2026-06-15T21:59:59.999Z"
    );
    expect(closingMomentInstant("2026-01-15")?.toISOString()).toBe(
      "2026-01-15T22:59:59.999Z"
    );
  });

  it("rejects an impossible calendar date instead of rolling over into a neighbouring real date (codex review, RJC-394 amendment)", () => {
    // `new Date` never throws on an out-of-range day/month, it silently
    // overflows (`2026-02-30` -> March 2). Every raw string this function
    // hand-parses must be rejected as "no valid closing information"
    // instead, on both the instant and the boolean it feeds -- and it must
    // not throw.
    for (const impossible of [
      "2026-02-30",
      "2026-13-01",
      "2026-05-00",
      "2026-06-31",
      "2026-02-30T11:00:00",
    ]) {
      expect(closingMomentInstant(impossible)).toBeUndefined();
      expect(hasClosingMomentPassed(impossible)).toBe(false);
    }
  });
});

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const keyWithTitleBytes = (titleBytes: number): string =>
  buildDedupKey({
    opdrachtgeverNaam: "Harvey Nash",
    startDatum: "2026-09-01",
    titel: "a".repeat(titleBytes),
  });

describe("buildDedupKey byte bound (CTP-499)", () => {
  it("leaves a short key literal so existing dedup_groep rows keep matching", () => {
    expect(
      buildDedupKey({
        opdrachtgeverNaam: "Gemeente Amsterdam",
        startDatum: "2026-09-01",
        titel: "Senior Java Developer",
      })
    ).toBe("senior java developer\u001Fgemeente amsterdam\u001F2026-09-01");
  });

  it("replaces a 3368-byte normalised key with a fixed-length sha256 key", () => {
    // The shape that blocked Harvey Nash: a titel carrying the whole
    // beschrijving, 3,368 bytes once normalised, over the 2704-byte index max.
    const key = keyWithTitleBytes(
      3368 - "\u001Fharvey nash\u001F2026-09-01".length
    );

    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(byteLength(key)).toBe(71);
    expect(byteLength(key)).toBeLessThan(DEDUP_KEY_MAX_BYTES);
  });

  it("keeps two long keys distinct when they differ only past the byte limit", () => {
    const prefix = "x".repeat(DEDUP_KEY_MAX_BYTES + 100);
    const alpha = buildDedupKey({
      opdrachtgeverNaam: "Harvey Nash",
      startDatum: "2026-09-01",
      titel: `${prefix} alpha`,
    });
    const beta = buildDedupKey({
      opdrachtgeverNaam: "Harvey Nash",
      startDatum: "2026-09-01",
      titel: `${prefix} beta`,
    });

    expect(alpha).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(beta).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(alpha).not.toBe(beta);
  });

  it("is deterministic: the same long input always yields the same key", () => {
    expect(keyWithTitleBytes(4000)).toBe(keyWithTitleBytes(4000));
  });

  it("counts UTF-8 bytes rather than characters", () => {
    // Each euro sign is three UTF-8 bytes, so the character count is a third
    // of what the index actually measures.
    const underBound = boundDedupKey("\u20AC".repeat(600));
    const overBound = boundDedupKey("\u20AC".repeat(700));

    expect(byteLength(underBound)).toBe(1800);
    expect(underBound).not.toMatch(/^sha256:/u);
    expect(overBound).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("leaves a key exactly at the bound literal and digests one byte more", () => {
    const atBound = "y".repeat(DEDUP_KEY_MAX_BYTES);

    expect(boundDedupKey(atBound)).toBe(atBound);
    expect(boundDedupKey(`${atBound}y`)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
