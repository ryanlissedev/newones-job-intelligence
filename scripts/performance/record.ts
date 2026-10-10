export type RunKind = "cold" | "unknown" | "warm";
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const DATASET_DIGEST_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

export const isDatasetDigest = (value: string): boolean =>
  DATASET_DIGEST_PATTERN.test(value);

export interface PerformanceMetadata {
  branch?: string;
  "cache-state"?: string;
  commit?: string;
  concurrency?: string;
  /** A declared dataset requires dataset-digest so cohorts cannot alias. */
  dataset?: string;
  "dataset-digest"?: string;
  "error-count"?: string;
  "freshness-ms"?: string;
  "instrumentation-overhead-ms"?: string;
  "item-count"?: string;
  "index-state"?: string;
  job?: string;
  machine?: string;
  "percentile-p50"?: string;
  "percentile-p95"?: string;
  "percentile-p99"?: string;
  pipeline?: string;
  profile?: string;
  "postgres-image-digest"?: string;
  "postgres-version"?: string;
  provider?: string;
  "query-identity"?: string;
  "queryset-digest"?: string;
  region?: string;
  "records-per-second"?: string;
  "result-digest"?: string;
  runner?: string;
  "sequence-position"?: string;
  suite?: string;
  "timeout-count"?: string;
  toolchain?: string;
  "throughput-rps"?: string;
  "vacuum-state"?: string;
  "workload-version"?: string;
  workflow?: string;
}

export interface CohortDimensions {
  version: 2;
  label: string;
  executor: string;
  runKind: RunKind;
  commandFingerprint: string;
  provider: string | null;
  runner: string | null;
  machine: string;
  region: string | null;
  os: string;
  arch: string;
  bun: string;
  osRelease: string;
  cpuCount: number;
  cpuModel: string;
  memoryBytes: number;
  toolchain: string | null;
  cacheState: string | null;
  workflow: string | null;
  job: string | null;
  pipeline: string | null;
  suite: string | null;
  workloadVersion: string | null;
  workloadProfile: string | null;
  datasetDigest: string | null;
  querysetDigest: string | null;
  itemCount: number | null;
  concurrency: number | null;
  postgresImageDigest: string | null;
  postgresVersion: string | null;
  indexState: string | null;
  vacuumState: string | null;
}

export interface CommandWallClockMeasurement {
  kind: "command-wall-clock";
  boundary: "subprocess-spawn-to-exit";
  unit: "milliseconds";
}

export interface InProcessMonotonicMeasurement {
  kind: "in-process-monotonic";
  boundary: string;
  unit: "milliseconds";
}

export type PerformanceMeasurement =
  | CommandWallClockMeasurement
  | InProcessMonotonicMeasurement;

export interface PerformanceRecord {
  schemaVersion: 1;
  id: string;
  attempt: number;
  retryOf: string | null;
  label: string;
  executor: string;
  runKind: RunKind;
  command: string[];
  commandFingerprint: string;
  cohortDimensions: CohortDimensions;
  cohortFingerprint: string;
  measurement: PerformanceMeasurement;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  commandExitCode: number | null;
  commandStatus: "passed" | "failed" | "not-started";
  wrapperStatus: "complete" | "spawn-failed" | "evidence-write-failed";
  measurementError: {
    stage: "spawn" | "evidence-write";
    message: string;
  } | null;
  git: {
    sha: string | null;
    dirty: boolean | null;
  };
  runtime: {
    bun: string;
    os: string;
    osRelease: string;
    arch: string;
    cpuCount: number;
    cpuModel: string;
    memoryBytes: number;
  };
  resources: {
    cpuUserMicroseconds: number | null;
    cpuSystemMicroseconds: number | null;
    maxRssBytes: number | null;
    unsupportedReason: string | null;
  };
  metadata: PerformanceMetadata;
}

type JsonObject = Record<string, JsonValue>;

export class PerformanceSchemaError extends Error {
  constructor(filename: string, detail: string) {
    super(`Invalid performance record ${filename}: ${detail}`);
    this.name = "PerformanceSchemaError";
  }
}

const readObject = (
  value: JsonValue,
  filename: string,
  field: string,
  required: string[],
  optional: string[] = []
): JsonObject => {
  if (
    value === null ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !== "[object Object]"
  ) {
    throw new PerformanceSchemaError(filename, `${field} must be an object`);
  }
  // SAFETY: The object tag and non-array/null checks establish JsonObject.
  const object = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PerformanceSchemaError(
      filename,
      `${field} has unknown properties: ${unknown.join(", ")}`
    );
  }
  const missing = required.filter((key) => !(key in object));
  if (missing.length > 0) {
    throw new PerformanceSchemaError(
      filename,
      `${field} is missing required properties: ${missing.join(", ")}`
    );
  }
  return object;
};

const readString = (
  object: JsonObject,
  key: string,
  filename: string
): string => {
  const value = object[key];
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new PerformanceSchemaError(filename, `${key} must be a string`);
  }
  return String(value);
};

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const readLabel = (
  object: JsonObject,
  key: string,
  filename: string
): string => {
  const value = readString(object, key, filename);
  if (!SAFE_LABEL_PATTERN.test(value)) {
    throw new PerformanceSchemaError(
      filename,
      `${key} must contain only letters, numbers, underscores, or hyphens`
    );
  }
  return value;
};

const readNullableString = (
  object: JsonObject,
  key: string,
  filename: string
): string | null =>
  object[key] === null ? null : readString(object, key, filename);

const readNumber = (
  object: JsonObject,
  key: string,
  filename: string
): number => {
  const value = object[key];
  if (
    Object.prototype.toString.call(value) !== "[object Number]" ||
    !Number.isFinite(value)
  ) {
    throw new PerformanceSchemaError(filename, `${key} must be a number`);
  }
  return Number(value);
};

const readIntegerAtLeast = (
  object: JsonObject,
  key: string,
  filename: string,
  minimum: number
): number => {
  const value = readNumber(object, key, filename);
  if (!Number.isInteger(value) || value < minimum) {
    throw new PerformanceSchemaError(
      filename,
      `${key} must be an integer greater than or equal to ${minimum}`
    );
  }
  return value;
};

const RFC3339_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const RFC3339_OFFSET_PATTERN =
  /(?:[Zz]|[+-](?<hours>\d{2}):(?<minutes>\d{2}))$/u;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isValidRfc3339DateTime = (value: string): boolean => {
  if (!RFC3339_DATE_TIME_PATTERN.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const offset = value.match(RFC3339_OFFSET_PATTERN);
  const offsetHours = Number(offset?.groups?.hours ?? 0);
  const offsetMinutes = Number(offset?.groups?.minutes ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHours <= 23 &&
    offsetMinutes <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
};

const readDateTime = (
  object: JsonObject,
  key: string,
  filename: string
): string => {
  const value = readString(object, key, filename);
  if (!isValidRfc3339DateTime(value)) {
    throw new PerformanceSchemaError(
      filename,
      `${key} must be a valid date-time`
    );
  }
  return value;
};

const readNullableInteger = (
  object: JsonObject,
  key: string,
  filename: string
): number | null => {
  if (object[key] === null) {
    return null;
  }
  const value = readNumber(object, key, filename);
  if (!Number.isInteger(value)) {
    throw new PerformanceSchemaError(filename, `${key} must be an integer`);
  }
  return value;
};

const readNullableIntegerAtLeast = (
  object: JsonObject,
  key: string,
  filename: string,
  minimum: number
): number | null => {
  const value = readNullableInteger(object, key, filename);
  if (value !== null && value < minimum) {
    throw new PerformanceSchemaError(
      filename,
      `${key} must be greater than or equal to ${minimum}`
    );
  }
  return value;
};

const readNullableBoolean = (
  object: JsonObject,
  key: string,
  filename: string
): boolean | null => {
  const value = object[key];
  if (value === null) {
    return null;
  }
  if (Object.prototype.toString.call(value) !== "[object Boolean]") {
    throw new PerformanceSchemaError(
      filename,
      `${key} must be boolean or null`
    );
  }
  return Boolean(value);
};

const readRunKind = (object: JsonObject, filename: string): RunKind => {
  const value = object.runKind;
  if (value !== "cold" && value !== "unknown" && value !== "warm") {
    throw new PerformanceSchemaError(
      filename,
      "runKind must be cold, unknown, or warm"
    );
  }
  return value;
};

const readStringArray = (
  object: JsonObject,
  key: string,
  filename: string
): string[] => {
  const value = object[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => Object.prototype.toString.call(entry) !== "[object String]"
    )
  ) {
    throw new PerformanceSchemaError(
      filename,
      `${key} must be a non-empty string array`
    );
  }
  return value.map(String);
};

const IN_PROCESS_BOUNDARIES = new Set([
  "search-parser",
  "search-adapter",
  "search-engine",
  "search-facets",
  "search-serialization",
  "search-summary",
  "ingest-queuewait",
  "ingest-discover",
  "ingest-fetch",
  "ingest-raw-write",
  "ingest-normalisation",
  "ingest-dedupe",
  "ingest-commit",
  "ingest-outbox",
  "ingest-index-projection",
  "api-handler",
  "db-poolwait",
  "db-query",
  "db-transaction",
  "db-locks",
  "instrumentation-overhead",
]);

const METADATA_KEYS = [
  "branch",
  "cache-state",
  "commit",
  "concurrency",
  "dataset",
  "dataset-digest",
  "error-count",
  "freshness-ms",
  "instrumentation-overhead-ms",
  "item-count",
  "index-state",
  "job",
  "machine",
  "percentile-p50",
  "percentile-p95",
  "percentile-p99",
  "pipeline",
  "profile",
  "postgres-image-digest",
  "postgres-version",
  "provider",
  "query-identity",
  "queryset-digest",
  "records-per-second",
  "region",
  "result-digest",
  "runner",
  "sequence-position",
  "suite",
  "timeout-count",
  "throughput-rps",
  "toolchain",
  "vacuum-state",
  "workload-version",
  "workflow",
] as const;

const readMetadata = (
  value: JsonValue,
  filename: string
): PerformanceMetadata => {
  const object = readObject(
    value,
    filename,
    "metadata",
    [],
    [...METADATA_KEYS]
  );
  const metadata: PerformanceMetadata = {};
  for (const key of METADATA_KEYS) {
    if (key in object) {
      metadata[key] = readString(object, key, filename);
    }
  }
  const sequencePosition = metadata["sequence-position"];
  if (sequencePosition !== undefined) {
    const parsed = Number(sequencePosition);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      throw new PerformanceSchemaError(
        filename,
        "metadata sequence-position must be an integer from 1 through 10000"
      );
    }
  }
  if (metadata.dataset !== undefined) {
    const datasetDigest = metadata["dataset-digest"];
    if (datasetDigest === undefined) {
      throw new PerformanceSchemaError(
        filename,
        "metadata dataset requires dataset-digest"
      );
    }
  }
  const datasetDigest = metadata["dataset-digest"];
  if (datasetDigest !== undefined && !isDatasetDigest(datasetDigest)) {
    throw new PerformanceSchemaError(
      filename,
      "metadata dataset-digest must match <algorithm>:<digest> using safe characters"
    );
  }
  return metadata;
};

const COHORT_KEYS = [
  "version",
  "label",
  "executor",
  "runKind",
  "commandFingerprint",
  "provider",
  "runner",
  "machine",
  "region",
  "os",
  "arch",
  "bun",
  "osRelease",
  "cpuCount",
  "cpuModel",
  "memoryBytes",
  "toolchain",
  "cacheState",
  "workflow",
  "job",
  "pipeline",
  "suite",
  "workloadVersion",
  "workloadProfile",
  "datasetDigest",
  "querysetDigest",
  "itemCount",
  "concurrency",
  "postgresImageDigest",
  "postgresVersion",
  "indexState",
  "vacuumState",
] as const;

const readCohort = (value: JsonValue, filename: string): CohortDimensions => {
  const object = readObject(value, filename, "cohortDimensions", [
    ...COHORT_KEYS,
  ]);
  if (readNumber(object, "version", filename) !== 2) {
    throw new PerformanceSchemaError(
      filename,
      "cohortDimensions.version must be 2"
    );
  }
  return {
    arch: readString(object, "arch", filename),
    bun: readString(object, "bun", filename),
    cacheState: readNullableString(object, "cacheState", filename),
    commandFingerprint: readString(object, "commandFingerprint", filename),
    concurrency: readNullableIntegerAtLeast(object, "concurrency", filename, 0),
    cpuCount: readIntegerAtLeast(object, "cpuCount", filename, 1),
    cpuModel: readString(object, "cpuModel", filename),
    datasetDigest: readNullableString(object, "datasetDigest", filename),
    executor: readString(object, "executor", filename),
    indexState: readNullableString(object, "indexState", filename),
    itemCount: readNullableIntegerAtLeast(object, "itemCount", filename, 0),
    job: readNullableString(object, "job", filename),
    label: readLabel(object, "label", filename),
    machine: readString(object, "machine", filename),
    memoryBytes: readIntegerAtLeast(object, "memoryBytes", filename, 1),
    os: readString(object, "os", filename),
    osRelease: readString(object, "osRelease", filename),
    pipeline: readNullableString(object, "pipeline", filename),
    postgresImageDigest: readNullableString(
      object,
      "postgresImageDigest",
      filename
    ),
    postgresVersion: readNullableString(object, "postgresVersion", filename),
    provider: readNullableString(object, "provider", filename),
    querysetDigest: readNullableString(object, "querysetDigest", filename),
    region: readNullableString(object, "region", filename),
    runKind: readRunKind(object, filename),
    runner: readNullableString(object, "runner", filename),
    suite: readNullableString(object, "suite", filename),
    toolchain: readNullableString(object, "toolchain", filename),
    vacuumState: readNullableString(object, "vacuumState", filename),
    version: 2,
    workflow: readNullableString(object, "workflow", filename),
    workloadProfile: readNullableString(object, "workloadProfile", filename),
    workloadVersion: readNullableString(object, "workloadVersion", filename),
  };
};

const readMeasurementError = (
  value: JsonValue | undefined,
  filename: string
): PerformanceRecord["measurementError"] => {
  if (value === null) {
    return null;
  }
  const error = readObject(value ?? null, filename, "measurementError", [
    "stage",
    "message",
  ]);
  if (error.stage !== "spawn" && error.stage !== "evidence-write") {
    throw new PerformanceSchemaError(
      filename,
      "measurementError.stage is invalid"
    );
  }
  return {
    message: readString(error, "message", filename),
    stage: error.stage,
  };
};

const readCommandStatus = (
  value: JsonValue | undefined,
  filename: string
): PerformanceRecord["commandStatus"] => {
  if (value !== "passed" && value !== "failed" && value !== "not-started") {
    throw new PerformanceSchemaError(filename, "commandStatus is invalid");
  }
  return value;
};

const readWrapperStatus = (
  value: JsonValue | undefined,
  filename: string
): PerformanceRecord["wrapperStatus"] => {
  if (
    value !== "complete" &&
    value !== "spawn-failed" &&
    value !== "evidence-write-failed"
  ) {
    throw new PerformanceSchemaError(filename, "wrapperStatus is invalid");
  }
  return value;
};

const readAttempt = (object: JsonObject, filename: string): number => {
  const attempt = readNumber(object, "attempt", filename);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PerformanceSchemaError(
      filename,
      "attempt must be a positive integer"
    );
  }
  return attempt;
};

const readMeasurement = (
  value: JsonValue | undefined,
  filename: string
): PerformanceMeasurement => {
  const measurement = readObject(value ?? null, filename, "measurement", [
    "kind",
    "boundary",
    "unit",
  ]);
  const { kind } = measurement;
  const boundary = readString(measurement, "boundary", filename);
  const unit = readString(measurement, "unit", filename);
  if (unit !== "milliseconds") {
    throw new PerformanceSchemaError(
      filename,
      "measurement.unit must be milliseconds"
    );
  }
  if (kind === "command-wall-clock") {
    if (boundary !== "subprocess-spawn-to-exit") {
      throw new PerformanceSchemaError(
        filename,
        "command-wall-clock boundary must be subprocess-spawn-to-exit"
      );
    }
    return {
      boundary: "subprocess-spawn-to-exit",
      kind: "command-wall-clock",
      unit: "milliseconds",
    };
  }
  if (kind === "in-process-monotonic") {
    if (!IN_PROCESS_BOUNDARIES.has(boundary)) {
      throw new PerformanceSchemaError(
        filename,
        "in-process-monotonic boundary is not allowlisted"
      );
    }
    return {
      boundary,
      kind: "in-process-monotonic",
      unit: "milliseconds",
    };
  }
  throw new PerformanceSchemaError(filename, "measurement.kind is invalid");
};

export const parsePerformanceRecord = (
  value: JsonValue,
  filename: string
): PerformanceRecord => {
  const keys = [
    "schemaVersion",
    "id",
    "attempt",
    "retryOf",
    "label",
    "executor",
    "runKind",
    "command",
    "commandFingerprint",
    "cohortDimensions",
    "cohortFingerprint",
    "measurement",
    "startedAt",
    "endedAt",
    "durationMs",
    "commandExitCode",
    "commandStatus",
    "wrapperStatus",
    "measurementError",
    "git",
    "runtime",
    "resources",
    "metadata",
  ];
  const object = readObject(value, filename, "record", keys);
  if (readNumber(object, "schemaVersion", filename) !== 1) {
    throw new PerformanceSchemaError(filename, "schemaVersion must be 1");
  }
  const measurement = readMeasurement(object.measurement, filename);
  const git = readObject(object.git ?? null, filename, "git", ["sha", "dirty"]);
  const runtime = readObject(object.runtime ?? null, filename, "runtime", [
    "bun",
    "os",
    "osRelease",
    "arch",
    "cpuCount",
    "cpuModel",
    "memoryBytes",
  ]);
  const resources = readObject(
    object.resources ?? null,
    filename,
    "resources",
    [
      "cpuUserMicroseconds",
      "cpuSystemMicroseconds",
      "maxRssBytes",
      "unsupportedReason",
    ]
  );
  const commandStatus = readCommandStatus(object.commandStatus, filename);
  const wrapperStatus = readWrapperStatus(object.wrapperStatus, filename);
  return {
    attempt: readAttempt(object, filename),
    cohortDimensions: readCohort(object.cohortDimensions ?? null, filename),
    cohortFingerprint: readString(object, "cohortFingerprint", filename),
    command: readStringArray(object, "command", filename),
    commandExitCode: readNullableInteger(object, "commandExitCode", filename),
    commandFingerprint: readString(object, "commandFingerprint", filename),
    commandStatus,
    durationMs: readIntegerAtLeast(object, "durationMs", filename, 0),
    endedAt: readDateTime(object, "endedAt", filename),
    executor: readString(object, "executor", filename),
    git: {
      dirty: readNullableBoolean(git, "dirty", filename),
      sha: readNullableString(git, "sha", filename),
    },
    id: readString(object, "id", filename),
    label: readLabel(object, "label", filename),
    measurement,
    measurementError: readMeasurementError(object.measurementError, filename),
    metadata: readMetadata(object.metadata ?? null, filename),
    resources: {
      cpuSystemMicroseconds: readNullableIntegerAtLeast(
        resources,
        "cpuSystemMicroseconds",
        filename,
        0
      ),
      cpuUserMicroseconds: readNullableIntegerAtLeast(
        resources,
        "cpuUserMicroseconds",
        filename,
        0
      ),
      maxRssBytes: readNullableIntegerAtLeast(
        resources,
        "maxRssBytes",
        filename,
        0
      ),
      unsupportedReason: readNullableString(
        resources,
        "unsupportedReason",
        filename
      ),
    },
    retryOf: readNullableString(object, "retryOf", filename),
    runKind: readRunKind(object, filename),
    runtime: {
      arch: readString(runtime, "arch", filename),
      bun: readString(runtime, "bun", filename),
      cpuCount: readIntegerAtLeast(runtime, "cpuCount", filename, 1),
      cpuModel: readString(runtime, "cpuModel", filename),
      memoryBytes: readIntegerAtLeast(runtime, "memoryBytes", filename, 1),
      os: readString(runtime, "os", filename),
      osRelease: readString(runtime, "osRelease", filename),
    },
    schemaVersion: 1,
    startedAt: readDateTime(object, "startedAt", filename),
    wrapperStatus,
  };
};
