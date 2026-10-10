/**
 * Minimal 5-field cron evaluation in a named time zone.
 *
 * Written rather than pulled in: `apps/worker` schedules through Trigger.dev's
 * own `schedules.task({ cron: { pattern, timezone } })`, which runs on their
 * side and exposes nothing to compute the next fire time locally. The repo has
 * no cron dependency, and RJC-408 asks not to add one without checking.
 *
 * Only what `curated.bron.interval` actually holds is supported: `*`, `* / n`
 * steps, `a-b` ranges, `a,b` lists and plain numbers, over the standard five
 * fields.
 */

export const CRON_FIELD_COUNT = 5;

/** Guard against a pattern that never matches (e.g. 30 February). */
const MAX_SEARCH_STEPS = 10_000;

const MINUTE_MS = 60_000;

interface CronField {
  readonly max: number;
  readonly min: number;
  readonly values: ReadonlySet<number>;
}

interface CronExpression {
  readonly dayOfMonth: CronField;
  readonly dayOfWeek: CronField;
  /** Standard cron ORs day-of-month and day-of-week when both are restricted. */
  readonly dayUnion: boolean;
  readonly hour: CronField;
  readonly minute: CronField;
  readonly month: CronField;
}

interface LocalMoment {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly year: number;
}

const parseField = (
  raw: string,
  min: number,
  max: number
): CronField | null => {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || part.split("/").length > 2) {
      return null;
    }

    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      return null;
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      const first = Number(bounds[0]);
      if (!Number.isInteger(first)) {
        return null;
      }
      if (bounds.length === 1) {
        start = first;
        end = stepPart === undefined ? first : max;
      } else if (bounds.length === 2) {
        const second = Number(bounds[1]);
        if (!Number.isInteger(second)) {
          return null;
        }
        start = first;
        end = second;
      } else {
        return null;
      }
    }

    if (start < min || end > max || start > end) {
      return null;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values.size === 0 ? null : { max, min, values };
};

/** Parses a 5-field cron expression, or returns null when it is unusable. */
export const parseCronExpression = (
  expression: string
): CronExpression | null => {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== CRON_FIELD_COUNT) {
    return null;
  }

  const [rawMinute, rawHour, rawDayOfMonth, rawMonth, rawDayOfWeek] = fields;
  if (
    rawMinute === undefined ||
    rawHour === undefined ||
    rawDayOfMonth === undefined ||
    rawMonth === undefined ||
    rawDayOfWeek === undefined
  ) {
    return null;
  }

  const minute = parseField(rawMinute, 0, 59);
  const hour = parseField(rawHour, 0, 23);
  const dayOfMonth = parseField(rawDayOfMonth, 1, 31);
  const month = parseField(rawMonth, 1, 12);
  // 0 and 7 both mean Sunday; normalise 7 down after parsing.
  const dayOfWeek = parseField(rawDayOfWeek, 0, 7);

  if (
    minute === null ||
    hour === null ||
    dayOfMonth === null ||
    month === null ||
    dayOfWeek === null
  ) {
    return null;
  }

  const normalisedDayOfWeek = new Set(
    [...dayOfWeek.values].map((value) => (value === 7 ? 0 : value))
  );

  return {
    dayOfMonth,
    dayOfWeek: { max: 6, min: 0, values: normalisedDayOfWeek },
    dayUnion: rawDayOfMonth !== "*" && rawDayOfWeek !== "*",
    hour,
    minute,
    month,
  };
};

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = PART_FORMATTERS.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  PART_FORMATTERS.set(timeZone, formatter);
  return formatter;
};

/** Wall-clock fields of an instant in `timeZone`. */
export const zonedMoment = (instant: Date, timeZone: string): LocalMoment => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "0";
    // `hour12: false` renders midnight as 24 in some ICU versions.
    return Number(value) % (type === "hour" ? 24 : Number.POSITIVE_INFINITY);
  };
  return {
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    month: read("month"),
    year: read("year"),
  };
};

const offsetMsAt = (instant: Date, timeZone: string): number => {
  const local = zonedMoment(instant, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    0
  );
  // Drop seconds from both sides so the difference is a whole-minute offset.
  const flooredInstant = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  return asUtc - flooredInstant;
};

const sameMoment = (left: LocalMoment, right: LocalMoment): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute;

const DAY_MS = 86_400_000;

/**
 * The instant at which `local` occurs in `timeZone`.
 *
 * Returns null for wall-clock times that do not exist (the hour skipped when
 * clocks go forward). When a wall-clock time occurs twice (the hour repeated
 * when clocks go back) the earlier instant wins, which is what schedulers do:
 * the job fires once per local time, not twice.
 */
export const instantFromZonedMoment = (
  local: LocalMoment,
  timeZone: string
): Date | null => {
  const naive = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    0
  );

  const offsets = new Set([
    offsetMsAt(new Date(naive - DAY_MS), timeZone),
    offsetMsAt(new Date(naive), timeZone),
    offsetMsAt(new Date(naive + DAY_MS), timeZone),
  ]);

  const resolved = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) =>
      sameMoment(zonedMoment(new Date(candidate), timeZone), local)
    )
    .toSorted((a, b) => a - b);

  const [earliest] = resolved;
  return earliest === undefined ? null : new Date(earliest);
};

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const dayOfWeekOf = (local: LocalMoment): number =>
  new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();

const matchesDay = (
  expression: CronExpression,
  local: LocalMoment
): boolean => {
  const dayOfMonthMatch = expression.dayOfMonth.values.has(local.day);
  const dayOfWeekMatch = expression.dayOfWeek.values.has(dayOfWeekOf(local));
  return expression.dayUnion
    ? dayOfMonthMatch || dayOfWeekMatch
    : dayOfMonthMatch && dayOfWeekMatch;
};

const startOfNextMonth = (local: LocalMoment): LocalMoment =>
  local.month === 12
    ? { day: 1, hour: 0, minute: 0, month: 1, year: local.year + 1 }
    : { day: 1, hour: 0, minute: 0, month: local.month + 1, year: local.year };

const startOfNextDay = (local: LocalMoment): LocalMoment =>
  local.day >= daysInMonth(local.year, local.month)
    ? startOfNextMonth(local)
    : { ...local, day: local.day + 1, hour: 0, minute: 0 };

const startOfNextHour = (local: LocalMoment): LocalMoment =>
  local.hour === 23
    ? startOfNextDay(local)
    : { ...local, hour: local.hour + 1, minute: 0 };

const nextMinute = (local: LocalMoment): LocalMoment =>
  local.minute === 59
    ? startOfNextHour(local)
    : { ...local, minute: local.minute + 1 };

/**
 * First instant strictly after `after` that matches `expression` in `timeZone`.
 *
 * The search walks wall-clock fields rather than instants, so a DST shift can
 * only affect the final conversion back to an instant. Returns null for an
 * unparseable pattern, or one with no match inside the search bound.
 */
export const nextCronRun = (
  expression: string,
  after: Date,
  timeZone: string
): Date | null => {
  const parsed = parseCronExpression(expression);
  if (parsed === null) {
    return null;
  }

  let local = zonedMoment(new Date(after.getTime() + MINUTE_MS), timeZone);
  local = { ...local, minute: local.minute };

  for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
    if (!parsed.month.values.has(local.month)) {
      local = startOfNextMonth(local);
      continue;
    }
    if (!matchesDay(parsed, local)) {
      local = startOfNextDay(local);
      continue;
    }
    if (!parsed.hour.values.has(local.hour)) {
      local = startOfNextHour(local);
      continue;
    }
    if (!parsed.minute.values.has(local.minute)) {
      local = nextMinute(local);
      continue;
    }

    const instant = instantFromZonedMoment(local, timeZone);
    // A skipped wall-clock hour resolves to nothing; a repeated one can resolve
    // to an instant we have already passed. Either way, keep walking.
    if (instant !== null && instant.getTime() > after.getTime()) {
      return instant;
    }
    local = nextMinute(local);
  }

  return null;
};
