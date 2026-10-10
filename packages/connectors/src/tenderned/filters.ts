import type { TenderNedFilters } from "./types";

const POLL_TIME_ZONE = "Europe/Amsterdam";
const MILLISECONDS_PER_DAY = 86_400_000;

const formatDateInTimeZone = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Unable to format poll date");
  }
  return `${year}-${month}-${day}`;
};

/** Poll window from `daysBack` days before `now` through `now`, plus CPV + diensten filters.
 * The default reproduces docs/sources/tenderned.md's yesterday-through-today window. */
export const buildTenderNedPollFilters = (
  now = new Date(),
  timeZone = POLL_TIME_ZONE,
  daysBack = 1
): TenderNedFilters => {
  const since = new Date(now.getTime() - daysBack * MILLISECONDS_PER_DAY);
  return {
    cpvCodes: ["72000000-5", "79620000-6"],
    publicatieDatumVanaf: formatDateInTimeZone(since, timeZone),
    typeOpdracht: "D",
  };
};
