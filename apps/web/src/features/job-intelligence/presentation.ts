import { parseBooleanQuery } from "@ji/domain";

import type {
  FreshnessFilter,
  JobContractType,
  JobEnrichedField,
  JobListing,
  JobRatePeriod,
  JobSearchStatus,
  JobSort,
  JobSource,
} from "./types";
import { AANGEVULD_MIN_CONFIDENCE } from "./types";

// RJC-368: fallback labels for the fixture demo sources only. Real bronnen
// get their label from the live /v1/bronnen catalog (see JobSourceOption);
// sourceLabel() falls back to the raw slug for anything not listed here.
const fixtureSourceLabels: ReadonlyMap<string, string> = new Map([
  ["indeed", "Indeed"],
  ["inhuurdesk", "Inhuurdesk"],
  ["nationale-vacaturebank", "Nationale Vacaturebank"],
  ["tenderned", "TenderNed"],
  ["werkenvoor", "Werken voor Nederland"],
]);

export const sourceLabel = (source: JobSource): string =>
  fixtureSourceLabels.get(source) ?? source;

export const contractLabels = {
  detachering: "Detachering",
  freelance: "Freelance",
  interim: "Interim",
  vast: "Vast",
} satisfies Record<JobContractType, string>;

export const werkvormLabels = {
  hybride: "Hybride",
  op_locatie: "Op locatie",
  remote: "Remote",
} as const;

export const queryScopeLabels = {
  all: "Volledige vacature",
  title: "Titel + opdrachtgever",
} as const;

export const freshnessLabels = {
  "24h": "Afgelopen 24 uur",
  "30d": "Afgelopen 30 dagen",
  "7d": "Afgelopen 7 dagen",
  all: "Alle publicatiedata",
} satisfies Record<FreshnessFilter, string>;

export const searchStatusLabels = {
  active: "Open",
  closed: "Gesloten",
  stale: "Stale / niet recent gezien",
  unknown: "Onbekend",
} satisfies Record<JobSearchStatus, string>;

export const sortLabels = {
  "closing-soon": "Sluitingsdatum",
  "company-asc": "Opdrachtgever A–Z",
  newest: "Nieuwste eerst",
  oldest: "Oudste eerst",
  "rate-high": "Hoogste tarief per periode",
  "rate-low": "Laagste tarief per periode",
  relevance: "Relevantie",
  "title-asc": "Titel A–Z",
} satisfies Record<JobSort, string>;

const dateFormatter = new Intl.DateTimeFormat("nl-NL", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const currencyFormatter = new Intl.NumberFormat("nl-NL", {
  currency: "EUR",
  maximumFractionDigits: 0,
  style: "currency",
});

export const formatDate = (value: string | null): string =>
  value ? dateFormatter.format(new Date(value)) : "Onbekend";

export const formatContract = (job: JobListing): string =>
  job.contractType ? contractLabels[job.contractType] : "Onbekend";

/**
 * The work-form label the source published, or null when absent. Callers that
 * render "Onbekend"/"—" for missing data decide that themselves.
 */
export const remoteLabel = (job: JobListing): string | null => {
  if (job.workArrangement) {
    return job.workArrangement;
  }
  if (job.remote === null) {
    return null;
  }
  return job.remote ? "Hybride" : "Op locatie";
};

export const formatRemote = (job: JobListing): string =>
  remoteLabel(job) ?? "Onbekend";

const ratePeriodSuffixes = {
  day: "/ dag",
  hour: "/ uur",
  month: "/ maand",
  unknown: "(periode onbekend)",
  year: "/ jaar",
} satisfies Record<JobRatePeriod, string>;

export interface RateParts {
  /** Suffix for the value, e.g. "/ uur" or "(periode onbekend)". */
  readonly period: string;
  /** Amount without the period suffix, e.g. "€ 3.150–€ 6.500". */
  readonly value: string;
}

/**
 * Rate split into primary (amount) and secondary (period) parts so the results
 * table can put them on separate lines. Null when the source published none.
 */
export const formatRateParts = (job: JobListing): RateParts | null => {
  if (!job.rate) {
    return null;
  }

  const period = ratePeriodSuffixes[job.rate.period];
  if (job.rate.min === null) {
    return { period, value: `tot ${currencyFormatter.format(job.rate.max)}` };
  }
  if (job.rate.max === null) {
    return {
      period,
      value: `vanaf ${currencyFormatter.format(job.rate.min)}`,
    };
  }
  if (job.rate.min === job.rate.max) {
    return { period, value: currencyFormatter.format(job.rate.max) };
  }
  return {
    period,
    value: `${currencyFormatter.format(job.rate.min)}–${currencyFormatter.format(job.rate.max)}`,
  };
};

export const formatRate = (job: JobListing): string => {
  const parts = formatRateParts(job);
  return parts ? `${parts.value} ${parts.period}` : "Tarief onbekend";
};

export const primarySource = (job: JobListing): string => {
  const [source] = job.sourceRecords;
  return source?.displayName ?? "Bron onbekend";
};

const describeBooleanError = (message: string, offset: number): string => {
  if (message === "Unclosed phrase") {
    return "Een aangehaalde zoekterm mist een afsluitend aanhalingsteken.";
  }
  if (message === "Unclosed parenthesis") {
    return "Een zoekgroep mist een afsluitende haak.";
  }
  if (message === "Unexpected closing parenthesis") {
    return `Onverwachte sluithaak op positie ${offset + 1}.`;
  }
  return `Boolean-query klopt niet op positie ${offset + 1}. Controleer de operators en zoektermen.`;
};

export const validateBooleanPreview = (query: string): string | null => {
  if (!query.trim()) {
    return null;
  }
  const result = parseBooleanQuery(query);
  return result.ok
    ? null
    : describeBooleanError(result.error.message, result.error.offset);
};

export const describeApiSyntaxError = (
  message: string,
  offset?: number
): string => {
  if (offset === undefined) {
    return message;
  }
  return describeBooleanError(message, offset);
};

export const isFieldAangevuld = (
  job: JobListing,
  field: JobEnrichedField["field"]
): boolean => {
  const enriched = job.enrichedFields?.find((entry) => entry.field === field);
  return (
    enriched !== undefined && enriched.confidence >= AANGEVULD_MIN_CONFIDENCE
  );
};

export const aangevuldLabel = (field: JobEnrichedField["field"]): string =>
  `aangevuld (${field})`;
