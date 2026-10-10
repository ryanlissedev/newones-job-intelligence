/**
 * Persist /jobs results chrome (CTP-509).
 * Motian keeps page size in the shareable URL (`perPage`); we mirror that and
 * also remember the last choice + view mode in localStorage for return visits.
 */

import {
  DEFAULT_RESULTS_VIEW_MODE,
  JOB_PAGE_SIZE,
  JOB_PAGE_SIZE_OPTIONS,
  RESULTS_VIEW_MODES,
} from "./types";
import type { JobPageSize, ResultsViewMode } from "./types";

export const JOBS_PAGE_SIZE_STORAGE_KEY = "ji.jobs.pageSize";
export const JOBS_VIEW_MODE_STORAGE_KEY = "ji.jobs.viewMode";

const isJobPageSize = (value: number): value is JobPageSize =>
  JOB_PAGE_SIZE_OPTIONS.some((option) => option === value);

const isResultsViewMode = (value: string): value is ResultsViewMode =>
  RESULTS_VIEW_MODES.some((option) => option === value);

const browserLocalStorage = (): Storage | null => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

const readStorage = (key: string): string | null => {
  const storage = browserLocalStorage();
  if (storage === null) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string): void => {
  const storage = browserLocalStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // Quota / private mode — prefs are best-effort.
  }
};

export const readStoredJobPageSize = (): JobPageSize => {
  const raw = readStorage(JOBS_PAGE_SIZE_STORAGE_KEY);
  if (raw === null) {
    return JOB_PAGE_SIZE;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && isJobPageSize(parsed)
    ? parsed
    : JOB_PAGE_SIZE;
};

export const writeStoredJobPageSize = (pageSize: JobPageSize): void => {
  writeStorage(JOBS_PAGE_SIZE_STORAGE_KEY, String(pageSize));
};

export const readStoredResultsViewMode = (): ResultsViewMode => {
  const raw = readStorage(JOBS_VIEW_MODE_STORAGE_KEY);
  return raw !== null && isResultsViewMode(raw)
    ? raw
    : DEFAULT_RESULTS_VIEW_MODE;
};

export const writeStoredResultsViewMode = (viewMode: ResultsViewMode): void => {
  writeStorage(JOBS_VIEW_MODE_STORAGE_KEY, viewMode);
};
