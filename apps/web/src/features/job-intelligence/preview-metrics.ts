import type { JobListing } from "./types";

const DAYS_PER_WEEK = 7;
const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_WEEK = DAYS_PER_WEEK * MILLISECONDS_PER_DAY;
const RATE_BUCKET_SIZE = 10;
const MONDAY_OFFSET = 6;

export interface WeeklyVolumePoint {
  readonly count: number;
  /** ISO timestamp of the Monday that opens the week. */
  readonly week: string;
}

export interface CountedValue {
  readonly count: number;
  readonly label: string;
  /** The filter value behind the label — a bron slug, a location, a skill. */
  readonly value: string;
}

export interface RateBucket {
  readonly bucket: number;
  readonly count: number;
}

const startOfWeekUtc = (isoDate: string): number => {
  const date = new Date(isoDate);
  const weekdayFromMonday = (date.getUTCDay() + MONDAY_OFFSET) % DAYS_PER_WEEK;
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - weekdayFromMonday
  );
};

const byCountThenLabel = (left: CountedValue, right: CountedValue): number =>
  right.count - left.count || left.label.localeCompare(right.label, "nl");

/**
 * Publication volume per calendar week, with empty weeks inside the range
 * kept as explicit zeros — a gap in the area chart would read as "no data
 * here" rather than "nothing was published that week".
 */
export const weeklyPublicationVolume = (
  jobs: readonly JobListing[]
): readonly WeeklyVolumePoint[] => {
  if (jobs.length === 0) {
    return [];
  }

  const counts = new Map<number, number>();
  for (const { publishedAt } of jobs) {
    if (!publishedAt) {
      continue;
    }
    const week = startOfWeekUtc(publishedAt);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return [];
  }

  const weeks = [...counts.keys()];
  const first = Math.min(...weeks);
  const last = Math.max(...weeks);
  const series: WeeklyVolumePoint[] = [];
  for (let week = first; week <= last; week += MILLISECONDS_PER_WEEK) {
    series.push({
      count: counts.get(week) ?? 0,
      week: new Date(week).toISOString(),
    });
  }
  return series;
};

export const jobsPerSource = (
  jobs: readonly JobListing[],
  labelFor: (slug: string) => string
): readonly CountedValue[] => {
  const counts = new Map<string, number>();
  for (const { sourceRecords } of jobs) {
    // A job carries one record per bron it was seen on; each bron counts once
    // for that job, so a re-seen job never inflates its own bron's total.
    for (const slug of new Set(sourceRecords.map(({ name }) => name))) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, label: labelFor(value), value }))
    .toSorted(byCountThenLabel);
};

export const jobsPerLocation = (
  jobs: readonly JobListing[]
): readonly CountedValue[] => {
  const counts = new Map<string, number>();
  for (const { location } of jobs) {
    if (!location) {
      continue;
    }
    counts.set(location, (counts.get(location) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, label: value, value }))
    .toSorted(byCountThenLabel);
};

export const topSkills = (
  jobs: readonly JobListing[],
  limit: number
): readonly CountedValue[] => {
  const counts = new Map<string, number>();
  for (const { skills } of jobs) {
    for (const skill of skills) {
      counts.set(skill, (counts.get(skill) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ count, label: value, value }))
    .toSorted(byCountThenLabel)
    .slice(0, limit);
};

/**
 * €10 buckets over the hourly floor rate. Yearly rates are excluded rather
 * than converted: an invented hourly equivalent would put a number on the
 * axis that no source ever published.
 */
export const hourlyRateBuckets = (
  jobs: readonly JobListing[]
): readonly RateBucket[] => {
  const hourlyMinimums = jobs
    .map(({ rate }) => rate)
    .filter((rate): rate is NonNullable<JobListing["rate"]> => rate !== null)
    .filter(({ period }) => period === "hour")
    .map(({ max, min }) => {
      const floor = min ?? max;
      if (floor === null) {
        return null;
      }
      return Math.floor(floor / RATE_BUCKET_SIZE) * RATE_BUCKET_SIZE;
    })
    .filter((bucket): bucket is number => bucket !== null);

  if (hourlyMinimums.length === 0) {
    return [];
  }

  const counts = new Map<number, number>();
  for (const bucket of hourlyMinimums) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const first = Math.min(...hourlyMinimums);
  const last = Math.max(...hourlyMinimums);
  const buckets: RateBucket[] = [];
  for (let bucket = first; bucket <= last; bucket += RATE_BUCKET_SIZE) {
    buckets.push({ bucket, count: counts.get(bucket) ?? 0 });
  }
  return buckets;
};

export const countJobsWithHourlyRate = (jobs: readonly JobListing[]): number =>
  jobs.filter(({ rate }) => rate?.period === "hour").length;
