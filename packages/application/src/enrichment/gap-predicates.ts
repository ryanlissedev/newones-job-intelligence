import { CLEARED, UNKNOWN } from "@ji/domain";

/** Null, undefined, blank or the UNKNOWN sentinel. */
export const isMissingText = (value: string | null | undefined): boolean =>
  value === null ||
  value === undefined ||
  value.trim() === "" ||
  value.trim() === UNKNOWN;

/** CLEARED is a true clear (#213) — not a gap enrichment may fill. */
export const isClearedText = (value: string | null | undefined): boolean =>
  value !== null && value !== undefined && value.trim() === CLEARED;

/** Gaps enrichment may fill — excludes CLEARED tombstones (#213). */
export const isFillableGap = (value: string | null | undefined): boolean =>
  isMissingText(value) && !isClearedText(value);
